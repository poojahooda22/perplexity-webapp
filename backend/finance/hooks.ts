// ─────────────────────────────────────────────────────────────────────────
// Finance agent HOOKS — lifecycle interception around tool calls (the pi "hooks" idea
// on the Vercel AI SDK). The SDK has no single native pre-tool veto, so we reproduce it
// with withGuard(): a higher-order wrapper around a tool's `execute` that
//   • pre-call  (pi "tool_call")   — enforces a per-tool, per-minute BUDGET. This protects
//       the shared vendor free-tier caps (e.g. Twelve Data 8 credits/min — one API key for
//       ALL users, so the budget is correctly process-global). Over budget → returns an
//       error result to the model instead of spending a vendor credit.
//   • post-call (pi "tool_result") — logs the call + duration and patches a not-financial-
//       advice disclaimer onto the result so it always rides back to the model.
//
// Counters are in-memory per process (fine for a single instance / local dev). For a
// multi-instance deploy, back the window with Redis (see lib/ratelimit.ts).
// ─────────────────────────────────────────────────────────────────────────

const DISCLAIMER = "Informational only — not financial advice.";

// Per-tool sliding window: tool name → recent call timestamps (ms).
const callLog = new Map<string, number[]>();

/**
 * Sliding-window budget check. EXPORTED so tools enforce it INSIDE their cache fetcher —
 * i.e. only when a real upstream call happens. (Previously withGuard checked it pre-call,
 * which charged the budget on cache HITS too and caused false rate-limit vetoes.)
 */
export function withinBudget(name: string, perMinute: number): boolean {
  const now = Date.now();
  const recent = (callLog.get(name) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) {
    callLog.set(name, recent);
    return false;
  }
  recent.push(now);
  callLog.set(name, recent);
  return true;
}

/**
 * Thrown INSIDE a cache fetcher when the per-minute vendor budget is exhausted. getOrRefresh
 * serves a stale value if one exists; otherwise it rethrows this, and the tool catches it and
 * returns a typed `{ unavailable }` the model can relay — never a raw error string posing as data.
 */
export class RateBudgetError extends Error {
  constructor(public readonly tool: string) {
    super(`${tool}: per-minute budget exceeded`);
    this.name = "RateBudgetError";
  }
}

// We treat a tool's execute opaquely (any) on purpose: the AI SDK's Tool.execute is
// generically typed per-tool, so wrapping it with a concrete signature breaks assignability.
type GuardedExecute = (input: any, options: any) => Promise<any>;

/**
 * Post-call wrapper: log the call + duration and attach the not-advice disclaimer. The budget
 * veto is NOT here anymore — it lives inside each tool's cache fetcher (see withinBudget) so a
 * cache hit doesn't consume it. Forwards the full v6 options bag untouched.
 */
export function withGuard<T>(name: string, t: T): T {
  const inner = (t as { execute?: GuardedExecute }).execute;
  if (typeof inner !== "function") return t;
  const guarded: GuardedExecute = async (input, options) => {
    const t0 = Date.now();
    try {
      const out = await inner(input, options);
      console.log(`[finance-hook] tool_call ${name} ${JSON.stringify(input)} → ok in ${Date.now() - t0}ms`);
      // Attach the disclaimer to PLAIN OBJECT results only — never to arrays (spreading an
      // array into an object would corrupt it) or primitives.
      return out && typeof out === "object" && !Array.isArray(out)
        ? { ...out, _disclaimer: DISCLAIMER }
        : out;
    } catch (e) {
      console.error(
        `[finance-hook] tool_call ${name} FAILED in ${Date.now() - t0}ms:`,
        e instanceof Error ? e.message : e,
      );
      throw e;
    }
  };
  return { ...(t as object), execute: guarded } as T;
}
