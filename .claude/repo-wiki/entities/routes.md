---
title: HTTP route table
kind: entity
cites:
  - backend/index.ts
  - backend/finance/routes.ts
  - backend/discover/routes.ts
  - backend/connectors/gmail/routes.ts
  - backend/auth.ts
  - backend/lib/ratelimit.ts
fresh: 2026-06-24
---

# HTTP route table

Every HTTP route in the backend → its handler. **This replaces grepping `index.ts` to find where a route
lives.** Auth legend: **auth** = `middleware` (`backend/auth.ts:35`, Supabase JWT + user provisioning);
**IP-RL** = `financeRateLimit` (`backend/lib/ratelimit.ts:61`, public reads, by IP); **PUBLIC** = none.

The Express app is built and exported from `backend/index.ts:753`; the Vercel handler re-exports it at
`backend/api/index.ts:1`. Local `app.listen` is gated on `!process.env.VERCEL` (`backend/index.ts:748`).
Global CORS/preflight (OPTIONS→204) at `backend/index.ts:42`. **There is no `/health` or `/` route.**

## Core engine + conversations — inline in `backend/index.ts`
| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/conversations` | auth | `backend/index.ts:371` |
| GET | `/conversations/:conversationId` | auth | `backend/index.ts:387` |
| PATCH | `/conversations/:conversationId` | auth | `backend/index.ts:407` |
| DELETE | `/conversations/:conversationId` | auth | `backend/index.ts:430` |
| POST | `/perplexity_ask` | auth | `backend/index.ts:456` → see [ask-request-lifecycle](../flows/ask-request-lifecycle.md) |
| POST | `/perplexity_ask/follow_up` | auth | `backend/index.ts:622` |

Per-user rate limit on the ask endpoints: `createRateLimiter(20, 60_000)` (`backend/index.ts:76`).

## Finance — `app.use("/finance", financeRouter)` (`backend/index.ts:65`); router `backend/finance/routes.ts:27`
**LLM** = a Vercel-AI-Gateway-credit-bearing read flagged `{llm:true}` (freezable via `FINANCE_LLM_FROZEN`;
see [features/finance § cost control](../features/finance.md)). All reads served from cache via `getOrRefresh`.
| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/finance/crypto` | IP-RL | `routes.ts:78` → `fetchCrypto` |
| GET | `/finance/crypto/leaderboard` | IP-RL | `routes.ts:80` → `fetchCryptoLeaderboard` |
| GET | `/finance/crypto/index` | IP-RL | `routes.ts:82` → `fetchLuminaCrypto50` (range-keyed) |
| GET | `/finance/predictions` | IP-RL | `routes.ts:93` → `fetchPredictions` |
| GET | `/finance/indices` | IP-RL | `routes.ts:95` → `fetchIndices` (market-aware) |
| GET | `/finance/stocks` | IP-RL | `routes.ts:96` → `fetchStocks` |
| GET | `/finance/sectors` | IP-RL | `routes.ts:98` → `fetchSectors` |
| GET | `/finance/summary` | IP-RL | `routes.ts:101` → `fetchMarketSummary` · **LLM** |
| GET | `/finance/research` | IP-RL | `routes.ts:103` → `fetchAllResearch` · **LLM** |
| GET | `/finance/discover` | IP-RL | `routes.ts:105` → `fetchDiscover` |
| GET | `/finance/recession` | IP-RL | `routes.ts:109` → `fetchRecessionGauge` (Market Insights, GREEN) |
| GET | `/finance/gdelt` | IP-RL | `routes.ts:111` → `fetchNewsSentiment` (market-aware) |
| GET | `/finance/mood` | IP-RL | `routes.ts:113` → `fetchMarketMood` (market-aware) |
| GET | `/finance/briefing` | IP-RL | `routes.ts:115` → `generateBriefing` · **LLM** |
| GET | `/finance/scorecard` | IP-RL | `routes.ts:118` (uncached DB read — emits show immediately) |
| GET | `/finance/home` | IP-RL | `routes.ts:128` (aggregate landing payload) |
| POST | `/finance/cron/refresh` | `CRON_SECRET` (skipped if unset) | `routes.ts:192` · `?force=1` regenerates even fresh/frozen |
| POST | `/finance/cron/emit-calls` | `CRON_SECRET` (skipped if unset) | `routes.ts:215` (scorecard: emit daily call) |
| POST | `/finance/cron/resolve-calls` | `CRON_SECRET` (skipped if unset) | `routes.ts:224` (scorecard: resolve due calls) |

`?market=in` selects India (Yahoo), else US (`routes.ts:64`). The finance **chat** has no `/finance` route —
it runs through `/perplexity_ask` with `vertical:"finance"` (`backend/index.ts:501`).

## Discover (health/academic) — `app.use("/discover", discoverRouter)` (`backend/index.ts:68`); router `backend/discover/routes.ts:14`
| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/discover/academic` | IP-RL | `routes.ts:39` → `fetchAcademicDiscover` |
| GET | `/discover/health` | IP-RL | `routes.ts:40` → `fetchHealthDiscover` |
| POST | `/discover/cron/refresh` | `CRON_SECRET` (skipped if unset) | `routes.ts:44` |

## Connectors / Gmail — `app.use("/connectors/gmail", gmailRouter)` (`backend/index.ts:73`); router `backend/connectors/gmail/routes.ts:26`
Auth is **per-route** (not router-level) so `/callback` can stay public for Google's browser redirect.
| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/connectors/gmail/start` | auth | `routes.ts:37` (returns consent `{ url }` as JSON) |
| GET | `/connectors/gmail/callback` | **PUBLIC** (identity in sealed `state`) | `routes.ts:50` (302 back to frontend) |
| GET | `/connectors/gmail/status` | auth | `routes.ts:90` |
| POST | `/connectors/gmail/send` | auth | `routes.ts:99` |
| DELETE | `/connectors/gmail` | auth | `routes.ts:130` (disconnect + revoke) |

⚠️ The Gmail **send** HTTP route exists, but the assistant chat agent only wires **read-only** tools today —
see [ai-tools-registry](ai-tools-registry.md) and [connectors-gmail](../features/connectors-gmail.md).
The success redirect target of `/callback` is the heart of the post-connect nav — see
[connector-oauth-flow](../flows/connector-oauth-flow.md).
