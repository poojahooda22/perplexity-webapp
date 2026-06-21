# Hooks & Guardrails — the AI SDK lifecycle interceptors Lumina reproduces

> Every safety/cost control that wraps a tool call or a `streamText` run: the `withGuard` post-call
> log + disclaimer staple, the per-minute vendor **budget veto enforced INSIDE the cache fetcher** (so
> a cache HIT is never charged), `RateBudgetError`, `onStepFinish` step logging, abort-on-client-
> disconnect, and the per-user endpoint rate limiter. Read this when adding a tool that spends a
> quota, debugging a false rate-limit, or wiring loop observability. The Vercel AI SDK has **no single
> native pre-tool veto**, so Lumina rebuilds the "hooks" idea by hand — this ref shows exactly how.
>
> `lumina-` grounded: cites live files. Adjacent refs: **tool-calling-and-loops.md** (the tool/Zod
> contract + typed results these hooks wrap), **model-gateway-and-selection.md** (model routing),
> **streaming-and-wire-protocol.md** (the `res`/SSE the disconnect signal watches), and
> **finance-markets** (the vendor free-tier caps the budgets are tuned against).

Files: [`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts),
`cachedToolFetch`/`buildFinanceTools` in [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts),
`rateLimited`/`disconnectSignal`/`streamFinanceAnswer`/`streamAssistantAnswer` in
[`backend/index.ts`](../../../../backend/index.ts).

---

## 1. The "pi hooks" idea, ported to the AI SDK

Anthropic's agent harness ("pi") names lifecycle interception points around a tool call: a **pre-call**
hook (can veto/modify before the tool runs), a **post-call** hook (sees the result), and a
**step-end** hook (fires after each model+tool round-trip). The Vercel AI SDK gives you exactly one of
those natively — `onStepFinish` — and **no pre-tool veto and no post-tool transform**. Lumina rebuilds
the missing two with a higher-order wrapper (`withGuard`) and a fetcher-internal check, and uses the
native one for observability:

| pi hook | What it should do | How Lumina implements it | Where |
|---------|-------------------|--------------------------|-------|
| `tool_call` (pre) | Veto/throttle before spending | **budget check inside the cache fetcher** (`withinBudget`) — NOT in `withGuard` | `cachedToolFetch` in `tools.ts:36-39` |
| `tool_result` (post) | Log, transform the result | `withGuard` — logs call+duration, staples `_disclaimer` | `withGuard` in `hooks.ts:59` |
| step end | Observe each round-trip | native `onStepFinish` — logs tool names + finishReason | `index.ts:204` / `:260` |
| run abort | Stop a doomed run | `abortSignal: disconnectSignal(res)` | `index.ts:151`, `:202`/`:259` |
| (out of band) | Stop endpoint abuse | per-user `rateLimited` middleware-style gate | `index.ts:90` |

The non-obvious move: **the pre-call veto is NOT in the wrapper.** It lives one layer deeper, inside
the cache fetcher, for the reason in §3.

---

## 2. `withGuard` — the post-call wrapper (log + disclaimer staple)

`withGuard(name, tool)` takes a tool, replaces its `execute`, and returns a structurally-identical
tool. It does two things and is intentionally **pure post-call** ([`hooks.ts:59-81`](../../../../backend/finance/hooks.ts)):

```ts
export function withGuard<T>(name: string, t: T): T {
  const inner = (t as { execute?: GuardedExecute }).execute;
  if (typeof inner !== "function") return t;          // pass through tools w/o execute (e.g. loadSkill-less)
  const guarded: GuardedExecute = async (input, options) => {
    const t0 = Date.now();
    try {
      const out = await inner(input, options);        // ← forwards the FULL v6 options bag untouched
      console.log(`[finance-hook] tool_call ${name} ${JSON.stringify(input)} → ok in ${Date.now()-t0}ms`);
      return out && typeof out === "object" && !Array.isArray(out)
        ? { ...out, _disclaimer: DISCLAIMER }          // staple onto PLAIN OBJECTS only
        : out;
    } catch (e) { console.error(`[finance-hook] tool_call ${name} FAILED…`); throw e; }
  };
  return { ...(t as object), execute: guarded } as T;
}
```

Design rules to copy:

- **It returns the same type `T`.** It spreads the original tool and swaps `execute`, so the SDK still
  sees a valid `Tool`. The generic `<T>` + opaque `GuardedExecute = (input: any, options: any)` is
  deliberate: the SDK types `Tool.execute` per-tool, so a concrete signature breaks assignability
  (`hooks.ts:50-52`).
- **Forward `options` untouched.** The v6 execute receives a second options bag (`toolCallId`,
  `messages`, `abortSignal`, …). `withGuard` passes it straight through — never drop it.
- **Disclaimer staples onto plain objects only.** Spreading `_disclaimer` into an **array** would
  corrupt it (`{0:…,1:…,_disclaimer}`), and you can't spread a primitive. The `!Array.isArray(out)`
  guard is load-bearing. This is why every finance data tool returns an **object** (`{items,…}` /
  `{coins,…}` / `{unavailable}`), never a bare array — so the not-advice text always rides back to the
  model regardless of success/failure branch.
- **It logs, it does not swallow.** On throw it logs and **rethrows** — failure handling (typed
  `{unavailable}`) is the tool's job (§3), not the guard's.

Registration is one line per tool ([`tools.ts:174-177`](../../../../backend/finance/tools.ts)):

```ts
tools: {
  getQuote: withGuard("getQuote", getQuote),
  getCrypto: withGuard("getCrypto", getCrypto),
  getIndices: withGuard("getIndices", getIndices),
  financeWebSearch: withGuard("financeWebSearch", financeWebSearch),
  // loadSkill is NOT wrapped — it spends no vendor quota and needs no disclaimer.
}
```

> **Why not put the disclaimer in the persona?** Belt-and-suspenders: the persona tells the model to
> end with "Not financial advice," but `_disclaimer` rides on the **tool result** itself, so even if
> the model's prose drifts, the not-advice framing is in its context every step. Two independent
> controls, neither sufficient alone.

---

## 3. The budget veto — and why it lives in the fetcher, not the wrapper

The shared vendor free-tier caps (Twelve Data = 8 credits/min, **one API key for ALL users**) mean the
budget must be **process-global**, not per-user. The check is `withinBudget(name, perMinute)` — a
sliding 60s window keyed by tool name ([`hooks.ts:26-36`](../../../../backend/finance/hooks.ts)):

```ts
export function withinBudget(name: string, perMinute: number): boolean {
  const now = Date.now();
  const recent = (callLog.get(name) ?? []).filter((t) => now - t < 60_000); // drop expired
  if (recent.length >= perMinute) { callLog.set(name, recent); return false; }
  recent.push(now); callLog.set(name, recent); return true;                  // record + allow
}
```

The critical placement: `withinBudget` runs **inside the `getOrRefresh` fetcher**, which only executes
on a cache MISS ([`cachedToolFetch` in `tools.ts:28-45`](../../../../backend/finance/tools.ts)):

```ts
const r = await getOrRefresh(key, ttlSec, () => {
  if (!withinBudget(name, perMinute)) throw new RateBudgetError(name); // ← veto ONLY on a real upstream call
  return fetcher();
});
```

**This was a real bug.** Originally `withGuard` checked the budget pre-call — which charged the budget
on cache HITs too and produced false rate-limit vetoes (a comment in `hooks.ts:24-25` records it). The
fix: a cache HIT never enters the fetcher closure, so it can't touch the counter. The budget reflects
**actual upstream spend**, which is the only thing the vendor meters.

`RateBudgetError` is the typed signal ([`hooks.ts:43-48`](../../../../backend/finance/hooks.ts)) that
threads cleanly through the cache:

```
withinBudget false → throw RateBudgetError
  ├─ getOrRefresh has a stale value? → serves it (stale-on-error), budget never surfaces
  └─ nothing cached?               → rethrows → cachedToolFetch catches → returns { ok: false }
                                                 → tool returns { unavailable: "…rate-limited…" }
```

So the model **always** gets a typed, relayable result — never a thrown stack, never a fake number.
`cachedToolFetch` catches **only** `RateBudgetError` and rethrows everything else (`tools.ts:42-43`) —
a genuine upstream/network error is a real failure and should not masquerade as "rate-limited."

### The financeWebSearch exception — budget per-call, not in the fetcher

`financeWebSearch` is **not cached** (every call is a fresh Tavily credit), so there is no fetcher to
hide the check in. It calls `withinBudget("financeWebSearch", 10)` **directly per-call** and returns
`{unavailable}` on veto ([`tools.ts:144-146`](../../../../backend/finance/tools.ts)). This is correct
*because* every call truly spends — the cache-HIT-isn't-charged concern simply doesn't exist for an
uncached tool. **Rule:** budget inside the fetcher for cached tools; budget per-call for uncached ones.

### Budgets in the codebase (tune under the vendor cap)

| Tool | `perMinute` | Cache TTL | Vendor / why |
|------|------------|-----------|--------------|
| `getQuote` | 6 | 60s | Twelve Data, 8 credits/min, **1 credit per symbol** — headroom under 8 |
| `getCrypto` | 20 | 30s | CoinGecko free tier is generous; short TTL for price freshness |
| `getIndices` | 12 | 300s | keyless Yahoo chart API; indices move slowly |
| `financeWebSearch` | 10 | (uncached) | per Tavily credit; checked per-call |

---

## 4. `onStepFinish` — native step-end observability

The one genuinely native hook. It fires after each model→tool round-trip and Lumina uses it purely to
**log which tools each step used** ([`index.ts:204-207`](../../../../backend/index.ts)):

```ts
onStepFinish: (step) => {
  const used = (step.toolCalls ?? []).map((c) => c.toolName);
  if (used.length) console.log(`[finance-hook] step tools=[${used.join(",")}] finish=${step.finishReason}`);
},
```

The assistant vertical has the identical pattern with an `[assistant-hook]` tag (`index.ts:260-262`).
This log is the **first thing to check** when debugging "the agent invented a number" — if no
`[finance-hook] step tools=[…]` line appears, the model answered from memory and never called a tool
(fix in the persona / tool descriptions, not here). Pair it with `onError` on the same `streamText`
call (`index.ts:208`) so silent stream failures surface.

> Do NOT put cost/veto logic in `onStepFinish` — it fires **after** the tools already ran. It is
> observe-only. Vetoes belong in the fetcher (§3); abort belongs in `abortSignal` (§5).

---

## 5. Abort-on-disconnect — stop burning tokens & credits on a vanished client

`streamText` accepts an `abortSignal`; when it fires, the SDK stops the generation/tool loop.
`disconnectSignal(res)` produces a signal wired to the Express response close
([`index.ts:151-155`](../../../../backend/index.ts)):

```ts
function disconnectSignal(res: express.Response): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ac.abort(); }); // only abort an UNFINISHED stream
  return ac.signal;
}
```

The `!res.writableFinished` guard matters: `close` fires on **both** a client bail and a normal
completion; without the guard you'd "abort" every successful stream. Passed into every streaming
branch (`index.ts:202`, `:259`, and the default search path `:709`/`:858`). For finance this is
double-valuable — a disconnect stops not just token spend but **vendor credit** spend on a response
nobody will read.

> **Hard rule — never thread this signal into the shared cache fetcher.** `getOrRefresh` de-dupes
> concurrent callers into ONE in-flight fetch; if caller A's disconnect aborted that shared promise,
> callers B and C waiting on the same key would fail too. Cancellation happens **only at the
> `streamText` level**. This is documented inline at `cachedToolFetch` (`tools.ts:25-27`).

---

## 6. The per-user rate limiter — the outermost gate

Distinct from the per-tool vendor budget: this caps **how often a signed-in user can hit the paid
endpoints at all**, before any LLM/tool work starts. It's the stopgap "lock" until real
credits/billing lands ([`index.ts:82-96`](../../../../backend/index.ts)):

```ts
const RATE_LIMIT = 20; const RATE_WINDOW_MS = 60_000;
const rateHits = new Map<string, number[]>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const hits = (rateHits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now); rateHits.set(userId, hits);
  return hits.length > RATE_LIMIT;
}
```

Called at the **top** of `/perplexity_ask` and `/perplexity_ask/follow_up`, returning HTTP **429**
before any spend (`index.ts:605-606`, `:770-771`):

```ts
if (rateLimited(req.userId)) return res.status(429).json({ error: "Too many requests — please slow down." });
```

Without it, one signed-in user could loop the endpoint and run up Tavily + embedding + premium-model
(opus/gpt-5.5-pro) bills. Keyed by `req.userId` (so it's per-user, post-auth), sliding window.

### The three throttles compared (don't confuse them)

| Control | Scope | Keyed by | Trigger | Failure surface |
|---------|-------|----------|---------|-----------------|
| `rateLimited` | endpoint abuse | **per user** | request count > 20/min | HTTP **429** to client |
| `withinBudget` | vendor free-tier cap | **per tool (global)** | upstream calls/min | `{unavailable}` to **model** |
| cache TTL | dedupe identical reads | per cache key | HIT within TTL | (serves cached — no spend) |

---

## 7. Multi-instance caveat — all three counters are in-memory

`callLog`, `rateHits`, and the in-process cache map are **per-process / per-instance**. On Vercel's
multi-instance + cold-start-wiped serverless this makes every counter **best-effort**: 3 instances ×
20 = effectively 60 req/min/user; 3 instances each get the full vendor budget. For hard limits, back
the windows with Upstash Redis (the pattern exists in
[`backend/lib/ratelimit.ts`](../../../../backend/lib/ratelimit.ts), used by the public finance read
routes). For local dev / a single instance, in-memory is correct and zero-dependency. `hooks.ts:11-13`
and `index.ts:85-86` both flag this explicitly.

---

## 8. Decision framework — which guardrail does my change need?

```
Adding/changing a tool or endpoint
│
├─ Does the tool spend a metered VENDOR quota (API credit)?
│   ├─ yes, and it's CACHED      → withinBudget INSIDE the cache fetcher (cachedToolFetch); typed {unavailable} on veto
│   └─ yes, and it's UNCACHED    → withinBudget per-call in execute (like financeWebSearch); typed {unavailable}
│   └─ no (loadSkill, pure calc) → no budget; maybe skip withGuard entirely
│
├─ Should the result carry a disclaimer / be logged?      → wrap in withGuard("name", tool); return an OBJECT
├─ Is it a new streaming branch?                          → abortSignal: disconnectSignal(res) + onStepFinish log + onError
├─ Is it a new paid endpoint?                             → rateLimited(req.userId) → 429 at the top, before any spend
└─ Will this run on >1 instance with HARD limits needed?  → back the window with Redis (lib/ratelimit.ts)
```

---

## 9. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Budget check in `withGuard` / pre-call. | Inside the cache fetcher (`cachedToolFetch`) so a HIT isn't charged. This exact bug shipped once. |
| Read-then-write a shared counter from app code. | `withinBudget` does it in one sliding-window pass; never two-step a process-global counter. |
| Tool `throw`s on rate-limit / failure. | Throw `RateBudgetError` inside the fetcher → catch → return typed `{unavailable}` the model relays. |
| Catch-all `catch` in `cachedToolFetch`. | Catch **only** `RateBudgetError`; rethrow real errors so they don't masquerade as "rate-limited." |
| Returning a bare array from a tool. | Return an object (`{items}`/`{coins}`) so the `_disclaimer` staple applies and no array corruption. |
| Stapling `_disclaimer` to arrays/primitives. | `withGuard` guards with `typeof === "object" && !Array.isArray`. Keep it. |
| Threading the disconnect `AbortSignal` into the shared cache fetcher. | Cancel only at the `streamText` level; the shared in-flight fetch serves other callers. |
| `disconnectSignal` aborting on every `close`. | Guard with `!res.writableFinished` — `close` also fires on normal completion. |
| Putting veto/cost logic in `onStepFinish`. | It fires AFTER tools ran — observe-only. Veto in the fetcher; abort via `abortSignal`. |
| Skipping the per-user `rateLimited` gate on a paid endpoint. | 429 at the top before any Tavily/embedding/premium-model spend. |
| Trusting in-memory counters as hard limits on Vercel. | They're per-instance/best-effort; back with Redis for hard caps. |
| Dropping the v6 `options` bag when wrapping `execute`. | Forward `(input, options)` untouched — it carries `toolCallId`/`abortSignal`/`messages`. |

---

## 10. Verify

- A tool call logs `[finance-hook] tool_call <name> {…} → ok in Nms`; a step logs
  `[finance-hook] step tools=[…] finish=…`. No tool log on a data question = the model guessed.
- Hammer one tool past its `perMinute` within 60s → the tool returns `{unavailable}` (not a 500, not a
  fabricated number), and a cached value still serves if present (stale-on-error).
- A cache HIT does **not** advance the budget — repeat the same query within TTL many times; only the
  first MISS touches the counter.
- Kill the client mid-stream → generation stops; no further `[finance-hook] step` lines.
- Exceed 20 req/min as one user → HTTP 429 with `{ error: "Too many requests…" }`, no LLM spend.
- New file (`hooks.ts`/`tools.ts`) edits need a **full dev-server restart** (`bun --hot` misses new
  files); relative imports keep the `.js` extension (`from "./hooks.js"`).
