---
title: Frontend hooks → backend endpoints
kind: entity
cites:
  - frontend/src/hooks/use-chat.ts
  - frontend/src/hooks/use-conversations.ts
  - frontend/src/hooks/use-finance.ts
  - frontend/src/hooks/use-discover.ts
  - frontend/src/hooks/use-connectors.ts
  - frontend/src/hooks/use-live-prices.ts
fresh: 2026-06-22
---

# Frontend hooks → backend endpoints

Each custom hook in `frontend/src/hooks/` and the endpoint it wraps. **Start here to find which hook owns a
piece of data, then jump to its API-client function in `frontend/src/lib/`.**

| Hook | Endpoint(s) | API client fn |
|---|---|---|
| `useChat` (`use-chat.ts:24`) | `POST /perplexity_ask`, `POST /perplexity_ask/follow_up`, `GET /conversations/:id` | `streamAsk`/`streamFollowUp`/`fetchConversation` |
| `useConversations` (`use-conversations.ts:18`) | `GET /conversations` | `fetchConversations` |
| `useRenameConversation` (`use-conversations.ts:28`) | `PATCH /conversations/:id` | `renameConversation` (optimistic) |
| `useDeleteConversation` (`use-conversations.ts:49`) | `DELETE /conversations/:id` | `deleteConversation` (optimistic) |
| `useAcademicDiscover` (`use-discover.ts:10`) | `GET /discover/academic` | `fetchAcademicDiscover` |
| `useHealthDiscover` (`use-discover.ts:20`) | `GET /discover/health` | `fetchHealthDiscover` |
| `useCrypto` (`use-finance.ts:35`) | `GET /finance/crypto` | `fetchCrypto` |
| `usePredictions` (`use-finance.ts:44`) | `GET /finance/predictions` | `fetchPredictions` |
| `useIndices` (`use-finance.ts:53`) | `GET /finance/indices` | `fetchIndices` |
| `useStocks` (`use-finance.ts:62`) | `GET /finance/stocks` | `fetchStocks` |
| `useSectors` (`use-finance.ts:71`) | `GET /finance/sectors` | `fetchSectors` |
| `useMarketSummary` (`use-finance.ts:80`) | `GET /finance/summary` | `fetchMarketSummary` |
| `useResearch` (`use-finance.ts:89`) | `GET /finance/research` | `fetchResearch` |
| `useDiscover` (`use-finance.ts:98`) | `GET /finance/discover` | `fetchDiscover` |
| `useGmailStatus` (`use-connectors.ts:10`) | `GET /connectors/gmail/status` | `gmailStatus` |
| `useGmailDisconnect` (`use-connectors.ts:19`) | `DELETE /connectors/gmail` | `gmailDisconnect` |
| `useGmailSend` (`use-connectors.ts:28`) | `POST /connectors/gmail/send` | `gmailSend` |
| `useInvalidateGmailStatus` (`use-connectors.ts:33`) | — (cache invalidator after OAuth round-trip) | — |
| `useLivePrices` (`use-live-prices.ts:24`) | **not HTTP** — Supabase Realtime channel `prices:top`; merges ticks into `["finance","stocks","us"]` + `["finance","crypto"]` queries (`use-live-prices.ts:64-88`) | Supabase Realtime |

Finance hooks set `refetchInterval`/`staleTime` from the `TTL` map (`use-finance.ts:24`) tuned to the
backend cache window. `gmailStartUrl` (`GET /connectors/gmail/start`) is called directly in `Connectors.tsx`,
not via a hook. API-client files: `frontend/src/lib/api.ts` (chat + conversations + Gmail),
`finance-api.ts`, `discover-api.ts`. ⚠️ base-URL gotcha lives in `frontend/src/lib/config.ts` — see
[rules/frontend-base-url](../rules/frontend-base-url.md).
