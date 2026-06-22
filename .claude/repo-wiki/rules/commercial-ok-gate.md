---
title: The commercialOk licensing gate
kind: rule
owning_skill: finance-markets
cites:
  - backend/finance/sources.ts
  - backend/finance/news.ts
fresh: 2026-06-22
---

# The `commercialOk` licensing gate

**Rule (CLAUDE.md non-negotiable #2):** a free API tier is **not** a commercial-display license. Every
displayed data series carries a `Provenance` with a correct `commercialOk` (default `false`).

**Why:** displaying free-tier market/news data in a public product can breach the provider's terms. The
`commercialOk` flag is the explicit, auditable record of whether a series is cleared — so the UI/legal
posture is a code fact, not a guess.

**Where:** `Provenance` type at `backend/finance/sources.ts:15`; every provider sets it — full table in
[entities/market-data-providers.md](../entities/market-data-providers.md). Today **all are `false`**. News
bodies are deliberately dropped to headline+link only (`backend/finance/news.ts:289`) — see
[decisions/0003-news-headline-linkout-only](../decisions/0003-news-headline-linkout-only.md).