// Per-user in-memory sliding-window rate limit — a stopgap "lock" on the paid endpoints until a
// real credits/billing system lands. Without it, any signed-in user can loop the endpoint and run
// up Tavily + embedding + premium-model bills. In-memory + per-instance, so best-effort on
// multi-instance deploys — make it Redis for hard limits.
//
// A FACTORY (not a module global) so each instance owns its own window — which also makes it
// trivially unit-testable in isolation (no shared state leaking across tests).
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return function rateLimited(userId: string): boolean {
    const now = Date.now();
    const recent = (hits.get(userId) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(userId, recent);
    return recent.length > limit;
  };
}
