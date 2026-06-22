---
title: "ADR 0001 — Semantic ANSWER cache, not knowledge RAG (yet)"
kind: decision
owning_skill: rag-retrieval
cites:
  - backend/index.ts
fresh: 2026-06-22
---

# ADR 0001 — Semantic answer cache, not knowledge RAG (yet)

**Decision:** the pgvector layer caches **whole past answers** keyed by query embedding; it does **not** yet
retrieve knowledge **chunks** to ground a fresh generation. On a new query we embed it, cosine-search
`cached_query` (`<=>`), and if a near-duplicate exists within `DISTANCE_THRESHOLD=0.15` and `CACHE_TTL_DAYS=7`,
we **replay the stored answer** verbatim instead of generating.

**Where:** `embedQuery` (`backend/index.ts:293`), `findCachedAnswer` (`:307`), `cacheAnswer` (`:338`); gate
`cacheable = !isTimeSensitive(query) && no attachments` (`:534`). The finance/assistant verticals
deliberately skip it (`:498-499`).

**Why / alternative not taken:** true RAG (chunk → retrieve → ground generation with citations) is more
powerful but heavier to build and maintain. An answer cache delivers most of the latency/cost win for
repeated questions with far less machinery. The path to evolve this into a knowledge RAG is documented in the
[rag-retrieval](../../skills/rag-retrieval/SKILL.md) skill.

**Consequence:** the cache is fail-open (a `42P01` missing-table error trips a cooldown latch,
`noteCacheError` `:278`); it must never serve a stale answer to a time-sensitive query — hence the
`isTimeSensitive` gate (`backend/lib/query-policy.ts:6`).
