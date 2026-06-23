---
title: "ADR 0005 — the global Health feed excludes India-origin outlets"
kind: decision
owning_skill: health-discover
cites:
  - backend/discover/health.ts
  - backend/discover/shared.ts
fresh: 2026-06-24
---

# ADR 0005 — global Health Discover excludes India-origin outlets (+ 20 image-only cards)

**Decision:** the **global** Health Discover feed drops articles whose NewsData per-article `country`
names India (`backend/discover/health.ts → isIndiaOrigin`, applied in `fetchHealthNewsData` for any
non-`in` market). The **India** feed keeps querying `country=in` and keeps those outlets. Both feeds serve
up to **20** image-complete cards via `finalizeArticles(articles, { max: 20, requireImage: true })`
(`backend/discover/shared.ts:94`), and `fetchHealthDiscover` (`health.ts:166`) backfills NewsData→Tavily
when NewsData returns a partial page so the count holds after the filter trims it.

**Why / alternatives not taken:** Indian outlets (e.g. "Business News India") were leaking into the global
feed because the global query sent **no country filter** and the code did **zero** geo-filtering. Two
alternatives were rejected (operator chose the first): (a) restrict global to `country=us` — too narrow,
drops legitimate non-US international wires; (b) an international-agency domain allowlist — most "global"
feel but ongoing list upkeep. Filtering on the authoritative per-article `country` field keeps the feed
genuinely international while honoring "national outlets belong to the national feed."

**Consequence:** `MAX_ARTICLES` (18) stays the shared default; only Health opts into `{ max: 20 }`
(`shared.ts:26`, backward-compatible signature). `requireImage` guarantees no blank tiles (a broken
hotlink still falls back to the card's neutral placeholder on the frontend). `commercialOk` stays `false`
for the publisher-derived feed. Verified live: global = 20 cards / 0 India; India = 20 cards / ~11 India.
