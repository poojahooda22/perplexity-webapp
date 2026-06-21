# Tool Calling & Multi-Step Loops (Vercel AI SDK v6)

> The generic mechanics of model-driven function calling: how to define a `tool()`, bound its
> `inputSchema` with Zod, write a description that *routes* the model, run a bounded multi-step
> loop with `stopWhen`/`stepCountIs`, observe it with `onStepFinish`, return **typed results the
> model grounds in** (never throw data), inject secrets via closure, and gate writes with
> `needsApproval` (human-in-the-loop). Read this when defining or debugging any tool/tool loop.
> Adjacent refs: **hooks-and-guardrails.md** (the budget veto + `withGuard` + abort-on-disconnect
> wrapper), **lumina-agent-engine.md** (how the loop is wired into each vertical + the wire tail),
> **streaming-and-wire-protocol.md** (turning tool-collected sources into the `<SOURCES>` tail).
> Live examples cited here: [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts) and
> [`backend/connectors/gmail/tools.ts`](../../../../backend/connectors/gmail/tools.ts); the loop
> itself in `streamFinanceAnswer`/`streamAssistantAnswer` in
> [`backend/index.ts`](../../../../backend/index.ts).

---

## 1. The mental model — a tool is a *fact fetcher*, the model is the writer

The non-negotiable contract in this codebase: **the model never invents data; tools fetch it and
the model grounds its prose in the returned values.** A tool's job is to return structured, typed
state. The model's job is to call the right tool, read the result, and write the answer (with
as-of times / citations). This split is what makes finance prices trustworthy and assistant email
summaries accurate.

Two consequences follow and drive everything below:

1. **A tool must never `throw` a data condition.** "Rate-limited", "key missing", "not connected"
   are *results*, not exceptions — return them as typed objects (`{unavailable}`, `{error}`,
   `{needsKey}`) so the model can relay them in words. A throw aborts the stream mid-answer.
2. **A tool's `description` is a router, not a label.** The model picks tools purely from their
   descriptions. Say what it covers AND what it does NOT, or the model will misroute (call
   `getQuote` for crypto, etc.).

---

## 2. Anatomy of a `tool()`

```ts
import { tool } from "ai";
import { z } from "zod";

const getQuote = tool({
  description:
    "Get the latest price, daily change, and percent change for one or more US stock/ETF " +
    "tickers (e.g. AAPL, MSFT, NVDA). Use for any question about a stock's current price or " +
    "today's move. Does NOT cover crypto, indices, or non-US listings.",
  inputSchema: z.object({
    symbols: z.array(z.string()).min(1).max(8)
      .describe("Ticker symbols, e.g. ['MSFT','NVDA']. US equities/ETFs only."),
  }),
  execute: async ({ symbols }) => { /* fetch + return typed result */ },
});
```

Three parts, three rules:

| Part | Rule | Why |
|------|------|-----|
| `description` | State coverage **and** non-coverage; name the trigger condition ("Use for…"). | It is the only signal the model uses to route between tools. |
| `inputSchema` | Zod object; **only content args**; bound everything (`.min/.max/.int`), `.describe` each field. | Bounds stop the model passing a 10,000-item array; describes teach the format. Secrets/`userId` are NEVER here (§5). |
| `execute` | Returns a typed result; catches every failure mode into a typed state; never throws data. | The model relays results; a throw kills the stream. |

`getQuote` in [`tools.ts`](../../../../backend/finance/tools.ts) is the canonical shape. Note the
description's explicit "Does NOT cover crypto, indices, or non-US listings" — that single clause
is what keeps the model from calling it for `bitcoin`.

### Schema-design checklist

- `z.array(...).min(1).max(N)` — every list arg gets an upper bound (finance: `symbols` max 8,
  crypto `ids` max 15). An unbounded array is a denial-of-wallet on a metered vendor.
- `z.number().int().min(1).max(20)` for counts (gmail `listEmails.max`).
- `.optional()` + a documented default behavior for filters (gmail `listEmails.query`/`max`).
- `z.object({})` (empty) is valid and common for no-arg tools (`getIndices`, `unreadCount`).
- `.describe()` is not optional polish — it is in-band documentation the model reads. Put example
  values in it (`"['MSFT','NVDA']"`, `"'is:unread' or 'from:amazon'"`).

---

## 3. Returning typed results (the heart of the contract)

Pick a **discriminated shape per outcome** so the model can branch on which key is present. The
finance tools standardize on:

| Outcome | Shape | Model behavior |
|---------|-------|----------------|
| success | `{ items \| coins, provenance, fetchedAt, stale }` | Quote the figures, name the source + as-of time. |
| over budget / upstream rate-limited | `{ unavailable: "…rate-limited…try again shortly." }` | Tell the user data is momentarily unavailable. |
| missing API key (config error) | `{ error \| needsKey: "…API_KEY is not configured." }` | Tell the user to configure the key. |
| not connected / expired grant (gmail) | `{ error: "Gmail isn't connected. Tell the user to connect it…" }` | Instruct the user to (re)connect. |

`getQuote.execute` shows all three finance branches: `!res.ok → {unavailable}`,
`r.data.needsKey → {error}`, else the success object. The gmail `guard()` helper centralizes the
not-connected/expired mapping so all three read tools share one error vocabulary.

**Write the error message as an instruction to the model, not a stack trace.** Gmail's guard
returns `"Gmail isn't connected. Tell the user to connect it on the Connectors page."` — the model
reads it and relays the action. A bare `"401 Unauthorized"` would leak into the answer verbatim.

Return ISO strings, not `Date` objects (`fetchedAt: new Date(r.fetchedAt).toISOString()`), and
pass through `stale`/`provenance` so the model can hedge ("as of …, possibly delayed").

---

## 4. The multi-step loop — `stopWhen` / `stepCountIs` / `onStepFinish`

`streamText` runs an **agentic loop**: model emits tool calls → SDK executes them → results are
fed back → model continues, possibly calling more tools, until it produces a final text answer or
the stop condition trips. You MUST bound it.

```ts
const result = streamText({
  model: opts.model,
  system: opts.system,
  messages: opts.messages,
  tools,
  stopWhen: stepCountIs(6),               // bound tool round-trips per turn
  abortSignal: disconnectSignal(opts.res), // stop the loop if the client leaves
  onStepFinish: (step) => {                // observe each step (the "step end" hook)
    const used = (step.toolCalls ?? []).map((c) => c.toolName);
    if (used.length) console.log(`[finance-hook] step tools=[${used.join(",")}] finish=${step.finishReason}`);
  },
  onError: ({ error }) => console.error("finance streamText error:", error),
});
for await (const textPart of result.textStream) { opts.res.write(textPart); }
```

This is exactly `streamFinanceAnswer` / `streamAssistantAnswer` in
[`index.ts`](../../../../backend/index.ts). Knobs:

| Knob | What it does | This repo |
|------|-------------|-----------|
| `stopWhen: stepCountIs(N)` | Cap on tool round-trips. Without it the loop can run until the model stops calling tools — unbounded tokens + vendor credits. | `stepCountIs(6)` in both agent verticals. Tune up for chained tools (search → quote → search), down for single-fetch agents. |
| `abortSignal` | Cancels the whole loop when the client disconnects, so a vanished reader stops burning tokens/credits. | `disconnectSignal(res)` — an `AbortController` aborted on `res.on("close")` when `!writableFinished`. See **hooks-and-guardrails.md**. |
| `onStepFinish(step)` | Per-step observation: `step.toolCalls`, `step.toolResults`, `step.finishReason`, `step.usage`. Pure side-effect (logging/metrics) — cannot veto. | Logs `[finance-hook] step tools=[…]` so you can confirm the tools actually fired. |
| `onError({error})` | Surfaces mid-stream errors. **`streamText` swallows them by default** — without this they vanish silently. | Set on every `streamText` call. |
| `toolChoice` | `"auto"` (default) / `"required"` / `"none"` / a specific tool. Force a first call or forbid tools. | Not used today (default auto); reach for `"required"` only when the first step MUST be a tool. |

`stepCountIs(N)` is the common case; `stopWhen` also accepts custom predicates (e.g. stop when a
specific tool has been called) and an array of conditions (stop if ANY trips).

### Why bound at the loop, not the tool

The budget veto (§ hooks) protects vendor credits **per tool**; `stepCountIs` protects against a
**runaway conversation** (model ping-ponging tools without converging). They are orthogonal — you
need both. A tool can be cheap and cached yet the model still loops 30 times without answering.

---

## 5. Closure-injected secure args (confused-deputy defense)

**Secrets and identity (`userId`, API keys, tokens) are injected via a per-request factory closure
— the model NEVER supplies them through `inputSchema`.** This is the single most important security
rule for tools that touch user data.

```ts
export function buildGmailTools({ userId }: { userId: string }) {
  return {
    getEmail: tool({
      description: "Read one email's full content … by id. Get the id from listEmails first.",
      inputSchema: z.object({ id: z.string().describe("The message id returned by listEmails.") }),
      execute: ({ id }) => guard(() => getMessage(userId, id)), // ← userId from closure, not schema
    }),
  };
}
```

The model passes `id` (content); `userId` is closed over from the authenticated request. If
`userId` were a schema field, a prompt-injection ("read user 42's inbox") could make the agent read
another user's mailbox — the classic confused-deputy attack. See the header comment in
[`gmail/tools.ts`](../../../../backend/connectors/gmail/tools.ts).

The same factory pattern powers `buildFinanceTools()`, which additionally returns a **fresh
`sources[]` accumulator per request** so concurrent requests never bleed each other's web sources.

| Arg type | Where it lives | Example |
|----------|---------------|---------|
| Content (what to fetch) | `inputSchema` — model supplies it | `symbols`, `query`, `id`, `max` |
| Identity / secrets | Factory closure — request supplies it | `userId`, the Tavily client built from `TAVILY_API_KEY` |
| Per-request state | Factory-scoped variable | the `sources[]` accumulator |

---

## 6. `needsApproval` — human-in-the-loop for write tools

Read tools (`getQuote`, `listEmails`) execute freely. **Write/side-effecting tools (send an email,
place an order, schedule a job) should gate on human approval** so the model can't take an
irreversible action on a hallucinated or injected instruction.

The gmail belt ships **read-only in M2a** by design — `sendEmail` is explicitly deferred to M2b
*with `needsApproval`* (see the file header in
[`gmail/tools.ts`](../../../../backend/connectors/gmail/tools.ts)). The v6 shape for that future
tool:

```ts
sendEmail: tool({
  description:
    "Send an email as the connected account. Use ONLY after the user has confirmed recipient, " +
    "subject, and body. Does NOT save drafts or schedule.",
  inputSchema: z.object({
    to: z.string().describe("Recipient address."),
    subject: z.string().max(200),
    body: z.string().max(10_000),
    cc: z.string().optional(),
    bcc: z.string().optional(),
  }),
  needsApproval: true, // pause the loop; the client must approve before execute runs
  execute: ({ to, subject, body, cc, bcc }) =>
    guard(() => sendGmail({ userId, to, subject, body, cc, bcc })), // userId from closure
});
```

How it runs: when the model calls a `needsApproval` tool, the SDK emits a **tool-approval request**
instead of executing — the loop pauses, the frontend surfaces a confirm UI, and on approval the
client sends the decision back and `execute` runs (on rejection the model is told it was denied and
continues). `needsApproval` can also be a **function** of the args for conditional gating (e.g.
approve sends to external domains but auto-run internal ones):

```ts
needsApproval: async ({ to }) => !to.endsWith("@yourcompany.com"),
```

| Tool kind | Approval | Rationale |
|-----------|----------|-----------|
| Read (quotes, list/read email, web search) | none | Idempotent, no side effects. |
| Write / irreversible (send email, place order, delete) | `needsApproval: true` (or a predicate) | One bad model step is irreversible; require a human gate. |

`sendGmail` (the underlying side-effect) already exists in
[`gmail/send.ts`](../../../../backend/connectors/gmail/send.ts); the M2b work is wrapping it as the
`needsApproval` tool above, registering it in `buildGmailTools`, and rendering the approval prompt.

---

## 7. The post-call wrapper (`withGuard`) — where cross-cutting concerns go

Finance tools are registered wrapped in `withGuard(name, tool)` (in
[`finance/hooks.ts`](../../../../backend/finance/hooks.ts)). The v6 SDK has **no single native
pre-tool veto**, so `withGuard` re-implements lifecycle hooks by wrapping `execute`:

- **post-call:** logs `[finance-hook] tool_call <name> {args} → ok in Nms` and staples
  `_disclaimer: "Informational only — not financial advice."` onto **plain-object** results only
  (never arrays/primitives — spreading an array into an object corrupts it).
- **budget (pre-call concept):** deliberately NOT in `withGuard` — it lives **inside the cache
  fetcher** (`withinBudget`) so a cache HIT isn't charged. (A previous pre-call check vetoed on
  hits — a real bug.) Full treatment in **hooks-and-guardrails.md**.

Registration pattern:

```ts
return {
  tools: {
    getQuote: withGuard("getQuote", getQuote),
    // …
    loadSkill,           // local, no vendor credit → needs no guard
  },
  sources,
};
```

`loadSkill` is intentionally **unwrapped** — it reads a bundled `.md`, spends no vendor credit, so
it needs no budget/disclaimer. Only wrap what has a cost or a cross-cutting concern.

---

## 8. Tools that feed the wire tail (`financeWebSearch`)

`financeWebSearch` is the special case worth studying: it is **not cached** (every call spends a
fresh Tavily credit, so its budget is checked per-call, not in a fetcher), and it pushes each result
into the shared `sources[]` while handing the model **global `[n]` numbers**:

```ts
const numbered = results.map((r) => {
  sources.push(r);
  return { n: sources.length, title: r.title, url: r.url, snippet: r.content };
});
return { sources: numbered };
```

The route reads that same `sources[]` after the stream to emit the `<SOURCES>` tail, so the model's
inline `[n]` citations line up with what the client renders. This is the pattern for any tool whose
results must surface in the UI, not just the prose — return state to the model **and** accumulate
into request-scoped state the route serializes. See **streaming-and-wire-protocol.md**.

---

## 9. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Tool `throw`s on rate-limit / not-connected / missing key. | Return typed `{unavailable}` / `{error}` / `{needsKey}`; the model relays it. A throw kills the stream mid-answer. |
| Description is a bare label ("Gets a stock quote"). | Say what it covers AND what it does NOT ("…Does NOT cover crypto, indices, or non-US"), plus the trigger ("Use for…"). The description is the router. |
| `userId`/API key as an `inputSchema` field. | Inject via the factory closure (`buildGmailTools({userId})`); schema carries only content args. Confused-deputy defense. |
| Unbounded array/number args (`z.array(z.string())`, `z.number()`). | Bound everything: `.min(1).max(8)`, `.int().min(1).max(20)`. Unbounded = denial-of-wallet on metered vendors. |
| No `stopWhen` — loop runs until the model stops calling tools. | `stopWhen: stepCountIs(N)` on every agentic `streamText` (6 here). |
| Ignoring client disconnect; loop keeps burning tokens/credits. | `abortSignal: disconnectSignal(res)`. |
| Relying on `streamText` to surface tool/loop errors. | It swallows them silently — always set `onError`. |
| Auto-executing a send/delete/order tool. | `needsApproval: true` (or a predicate) so a human gates irreversible actions. |
| Threading the request `AbortSignal` into a SHARED/de-duped cache fetcher. | Cancel at the `streamText` level only; one caller's disconnect must not abort the shared in-flight fetch. |
| `_disclaimer`/metadata spread onto array or primitive results. | Patch plain objects only; guard with `typeof out === "object" && !Array.isArray(out)`. |
| Returning `Date` objects / raw provider errors to the model. | ISO strings (`.toISOString()`); rewrite errors as instructions ("Tell the user to reconnect…"). |
| New tool file but `bun --hot` doesn't pick it up; relative import missing `.js`. | Full dev-server restart for new files; always `import { … } from "./x.js"` (Vercel's strict ESM resolver fails the build otherwise). |

---

## 10. Define-a-new-tool checklist

1. **Factory:** add it inside the request-scoped `build…Tools()` so closures (userId, accumulators)
   are fresh per request.
2. **Description:** coverage + non-coverage + "Use for…" trigger.
3. **Schema:** Zod object, content args only, every field bounded + `.describe`d, secrets via
   closure.
4. **Execute:** fetch (through cache/budget if it hits a metered vendor); return a typed
   success/`unavailable`/`error` shape; never throw data.
5. **Write tool?** add `needsApproval` (bool or predicate).
6. **Register:** add to the returned `tools` map; wrap in `withGuard` if it has a cost/disclaimer;
   leave local tools unwrapped.
7. **Loop:** confirm `stopWhen`/`abortSignal`/`onStepFinish`/`onError` are set on the `streamText`
   it runs under.
8. **Verify:** the `[finance-hook]`/`[assistant-hook]` step log shows your tool firing;
   `.js` extensions present; new file → full restart.
