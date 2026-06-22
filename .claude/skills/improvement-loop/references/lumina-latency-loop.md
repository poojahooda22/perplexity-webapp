# Worked example — Lumina's finance cold-fetch latency loop

The reference run of this skill (2026-06-22). One full cycle took every finance API's cold first-fetch
from seconds to milliseconds. Live record + per-cycle log:
[`.agents/latency-loop/cold-fetch-baseline.md`](../../../.agents/latency-loop/cold-fetch-baseline.md).

## The goal (a mechanically-verifiable exit metric)

> Every `/finance/*` cold first-fetch < 300 ms (the user's cold = **client cache empty AND backend cache
> empty** — the worst-case first-ever visitor). Warm/TanStack-cached fetches were explicitly out of scope.

This passes the bar in [`verifiable-exit-and-safety.md`](verifiable-exit-and-safety.md): a number a script
checks, per endpoint.

## MEASURE — the independent verifier

The `/finance/*` routes are **public** (mounted before the auth gate in `backend/index.ts`), so the
verifier needs no browser or login — **curl the endpoint and read `time_total`** (download is ~1 ms on
localhost, so it ≈ server time = the cold latency):

```bash
for ep in indices summary discover stocks sectors crypto predictions; do
  printf "/%-12s " "$ep"; curl -s -o /dev/null -w "%{time_total}s\n" "http://localhost:3001/finance/$ep"
done
```

Baseline (cache empty): summary **9308 ms**, predictions **6082**, stocks **4113**, discover **615**,
crypto **436**, sectors **352**, indices **308**.

## DIAGNOSE (read the code — don't guess)

A back-to-back curl returned summary in **3 ms** → the cache was NOT broken; the ~9 s readings were each a
genuine **cold MISS** after the TTL lapsed. Root cause, from reading the code:

1. **No stale-while-revalidate** — `backend/lib/cache.ts` `getOrRefresh` **blocked** on a stale-but-present
   read (re-fetched synchronously) instead of serving the stale copy + refreshing in the background. It
   only served stale on *error*, not on *age* → first user after every TTL lapse paid the full upstream cost.
2. **No warm-on-startup** — the cron warmer route existed in `backend/finance/routes.ts` but nothing called
   it at `app.listen` (`backend/index.ts`) → cache started empty after a restart.
3. Upstreams are intrinsically slow (Tavily+LLM ~9 s; Polymarket-timeout→Manifold ~6 s) — must be paid by
   the background refresh, never the user. (Per-endpoint fan-out was already `Promise.all`'d — not the issue.)

## RESEARCH → PLAN → RED GATE

Grounded the fix in stale-while-revalidate (RFC 5861) + cache-warming. Plan: **P0** SWR in the cache
layer; **P1** warm-on-startup. Stopped at the RED gate for green-light before any backend write.

## EXECUTE (the actual edits)

- **`backend/lib/cache.ts`** — `getOrRefresh` now: fresh → serve; **stale-but-present → serve stale
  instantly + `void doRefresh()` in the background**; empty → block once. Added exported `forceRefresh`
  (await fetch + write, de-duped via the existing `inflight` map) for the warmer.
- **`backend/finance/routes.ts`** — extracted `warmFinanceCache()` (uses `forceRefresh`), now covering
  `discover` + `research` too (previously unwarmed); the `/cron/refresh` route calls it.
- **`backend/index.ts`** — after `app.listen`, fire-and-forget `warmFinanceCache()` so the cache is
  populated before the first user (local only; Vercel relies on the cron route + Upstash).

## VERIFY (re-measure — the loop's evaluator)

| Endpoint | Cold baseline | After fix (first fetch post-restart) |
|---|---:|---:|
| summary | 9308 ms | **3.3 ms** |
| predictions | 6082 ms | **3.6 ms** |
| stocks | 4113 ms | **3.6 ms** |
| discover | 615 ms | **3.4 ms** |
| crypto | 436 ms | 3.5 ms |
| sectors | 352 ms | 4.2 ms |
| indices | 308 ms | 2.6 ms |

- **P1 verified:** first fetch after a *fresh restart*, with no manual warming, was < 5 ms → warm-on-startup
  populated the cache before the first user.
- **P0 verified:** read predictions *after* its 120 s TTL lapsed (genuinely stale) = **2.8 ms** (stale
  served) instead of blocking ~6 s. SWR holds *between* warms, not just right after one.
- **Code-live check:** the cron warmer returned the new `finance:`-prefixed key shape (incl. research +
  discover) — proof the new code was running, not a stale build.

**Exit condition met in one cycle.** No safety cap needed.

## Lessons logged (Reflexion-style, for the next loop)

- **Measure the metric you actually care about.** Early readings nearly recorded WARM latency (3 ms) and
  concluded "nothing to fix" — the COLD path was the target. Verify the right state.
- **`bun --hot` does NOT reload backend edits** (CLAUDE.md non-negotiable #7) — the first verify ran against
  OLD code (proven by the old cron key shape). A clean **restart** is part of EXECUTE for backend changes.
- **Disambiguate "broken" vs "expired".** Back-to-back calls (cache works) vs spaced calls (TTL lapsed)
  told the real story; the first wrong hypothesis ("summary cache is broken") was disproven by evidence.
- The verifier being **public + curl-based** made it auth-free and reproducible — pick a verifier that
  doesn't depend on fragile state (the browser session expired mid-run; curl didn't care).

## Prod caveat (so the fix holds beyond localhost)

Warm-on-startup only runs where the process stays alive. On **Vercel (serverless)** there's no persistent
listen, so prod needs: **`UPSTASH_*` set** (shared Redis — the in-memory fallback is cold-start-wiped) +
**cron-job.org POSTing `/finance/cron/refresh`** on an interval ≤ the shortest TTL. Both already exist in code.