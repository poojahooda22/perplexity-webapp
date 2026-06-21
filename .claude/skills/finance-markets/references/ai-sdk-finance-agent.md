# The Finance Chat Agent — AI SDK tool loop, hooks, and runtime skills

> How the `vertical:"finance"` agent fetches live data and answers grounded in it, without ever
> inventing a number. This ref is the **finance-specific** view of the engine; the generic
> mechanics (how `streamText`/tools/`stopWhen`/hooks work in the abstract, the prompt-assembly
> pattern, model gateway) belong to the **ai-sdk-agent** skill — read that for the engine, this
> for the finance tool belt.

Files: [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts),
[`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts),
[`backend/finance/skills.ts`](../../../../backend/finance/skills.ts),
`FINANCE_PERSONA` in [`backend/prompt.ts`](../../../../backend/prompt.ts),
`streamFinanceAnswer` in [`backend/index.ts`](../../../../backend/index.ts).

---

## 1. The loop, end to end

```
streamFinanceAnswer (index.ts)
  └─ streamText({
        model,                       // resolved Gateway id (anthropic/claude-sonnet-4.6 default)
        system: buildFinanceSystem() // FINANCE_PERSONA + <available_skills> manifest
        messages,
        tools: buildFinanceTools().tools,
        stopWhen: stepCountIs(6),     // bound tool round-trips per turn
        abortSignal: disconnectSignal(res),  // stop the loop if the client leaves
        onStepFinish: log tools used, // the pi "step end" hook
     })
  └─ for await (textPart of result.textStream) → res.write   // stream tokens live
  └─ append <SOURCES> tail from the sources[] accumulator
```

`buildFinanceTools()` returns a **fresh** tool set + a **fresh** `sources[]` array per request — no
cross-request bleed. The tools: `getQuote`, `getCrypto`, `getIndices`, `financeWebSearch`, `loadSkill`.

---

## 2. Tool design rules (the part that matters)

Every data tool follows the same contract — copy it for new tools:

1. **Typed description** that says what it covers AND what it does NOT (so the model routes
   correctly). E.g. `getQuote`: "US stock/ETF tickers… Does NOT cover crypto, indices, or non-US."
2. **Zod `inputSchema`** with bounds (`.min/.max`, `.describe`) — the model only supplies the
   *content* args, never `userId` or secrets.
3. **Fetch through the cache + budget** via `cachedToolFetch(name, perMinute, key, ttlSec, fetcher)`:
   `getOrRefresh` runs the fetcher only on a MISS; the `withinBudget` check lives **inside** the
   fetcher, so a cache HIT is never charged (this was a real bug — pre-call budget checks vetoed on
   hits).
4. **Return typed states, never throw data:**
   - success: `{items|coins, provenance, fetchedAt, stale}`
   - over budget / upstream rate-limited: `{unavailable: "…rate-limited…try again shortly."}`
   - missing key: `{error|needsKey}` so the model tells the user to configure it.
5. **Wrap in `withGuard(name, tool)`** — logs `[finance-hook] tool_call <name> … → ok in Nms` and
   staples `_disclaimer: "Informational only — not financial advice."` onto object results (never
   arrays/primitives).

**`financeWebSearch` is special:** not cached (every call is a fresh Tavily credit), so its budget
(10/min) is checked per-call. It pushes each result into the shared `sources[]` and hands the model
**GLOBAL `[n]` numbers** so the model's inline citations line up with the `<SOURCES>` tail the
client renders. This is how finance answers cite like Discover answers.

```ts
// Skeleton for a NEW finance data tool — match getQuote/getCrypto.
const getX = tool({
  description: "…what it does AND what it does NOT cover…",
  inputSchema: z.object({ ids: z.array(z.string()).min(1).max(N).describe("…") }),
  execute: async ({ ids }) => {
    const key = `finance:x:${normalize(ids)}`;
    const res = await cachedToolFetch("getX", PER_MIN, key, TTL_SEC, () => fetchX(ids));
    if (!res.ok) return { unavailable: "Live X data is rate-limited right now — try again shortly." };
    const r = res.r;
    return { items: r.data.items, provenance: r.data.provenance,
             fetchedAt: new Date(r.fetchedAt).toISOString(), stale: r.stale };
  },
});
// register: tools: { …, getX: withGuard("getX", getX) }
// budget: set PER_MIN under the vendor's free-tier cap (see market-data-providers.md)
```

**AbortSignal rule:** do NOT thread the request's disconnect signal into a *shared* cached fetcher —
it's de-duped across concurrent callers, so one disconnect must not abort the others. Disconnect
cancellation happens at the `streamText` level (`abortSignal: disconnectSignal(res)`).

---

## 3. Hooks (`withGuard`, `onStepFinish`)

The Vercel AI SDK has no single native pre-tool veto, so the budget veto lives inside the fetcher
(`withinBudget`) and `withGuard` does post-call concerns:
- **pre-call (conceptually):** budget — but enforced in the fetcher so HITs aren't charged.
- **post-call:** log + duration, and attach the not-advice disclaimer to every object result.
- **step end:** `onStepFinish` in `index.ts` logs which tools each step used + finishReason.

Counters are in-memory **per process** — correct for shared vendor keys on a single instance; back
the window with Redis for a multi-instance deploy.

---

## 4. Runtime skills (`loadSkill`) — the product's own progressive disclosure

Distinct from THESE dev skills. At runtime the finance agent has a small library of playbooks
([`backend/finance/skills/*.md`](../../../../backend/finance/skills/)):

- `skills.ts` reads each `.md`, parses `name` + `description` frontmatter (both required or it's
  skipped), and exposes:
  - `skillsManifest()` → `<available_skills>\n- name: description\n…</available_skills>` injected
    into the system prompt (only names+descriptions — cheap).
  - `loadSkill` tool → returns the **full body** on demand when the user's task matches an entry.
- The persona tells the model: when a request matches an `<available_skills>` entry, call `loadSkill`
  FIRST, then follow the playbook.
- **Fail-open:** if the `.md` files aren't bundled (serverless), the registry is empty and the agent
  runs fine without skills.

**Add a runtime playbook:** drop a `name`+`description` `.md` in `backend/finance/skills/` (see
`equity-analysis.md` for the shape — short, numbered, names the tools to call). It auto-appears in
the manifest. This is the right home for finance domain procedure; keep the *engine* knowledge in
these dev skills.

---

## 5. Persona contract (`FINANCE_PERSONA`)

- **Scope guard:** answers ONLY markets/stocks/ETFs/crypto/indices/macro/personal-finance concepts;
  declines off-topic in one sentence.
- **Tool-first:** call the right tool BEFORE answering anything needing live data; never invent a
  price/level/stat; state the as-of time; if a tool returns `unavailable`, say live data is
  momentarily rate-limited.
- **Citations:** `financeWebSearch` results cited inline `[n]`; price-tool figures name the source
  (Twelve Data/CoinGecko) + as-of time instead of `[n]`.
- **No advice:** never buy/sell/hold or personalized suitability; end with "Not financial advice."
- **Output protocol:** wrap in `<ANSWER>…</ANSWER>` + a `<FOLLOW_UPS>` block of 5 questions — the
  SAME protocol as Discover, so the existing chat UI renders finance answers unchanged.

---

## 6. Common tasks → where

| Task | Do |
|------|----|
| Add a new live-data tool | §2 skeleton; pick budget from `market-data-providers.md`; register + `withGuard`. |
| Agent invents a number | Tighten the persona tool-first rule; ensure the tool returns `unavailable` (not a throw) on failure; confirm `[finance-hook]` shows the call. |
| Add a finance procedure (e.g. "compare two ETFs") | A runtime playbook `.md` in `backend/finance/skills/`, not a code change. |
| Make citations line up | Route news through `financeWebSearch` so it assigns global `[n]` + pushes to `sources[]`. |
| Loop runs too long / too short | Tune `stepCountIs(N)` in `streamFinanceAnswer`. |
| Engine-level questions (model routing, compaction, generateObject) | → **ai-sdk-agent** skill. |
