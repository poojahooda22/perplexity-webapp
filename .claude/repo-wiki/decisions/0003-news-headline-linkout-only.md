---
title: "ADR 0003 — Finance/health news: headline + link-out only"
kind: decision
owning_skill: finance-markets
cites:
  - backend/finance/news.ts
  - backend/finance/research.ts
fresh: 2026-06-22
---

# ADR 0003 — News is headline + source + link + image only

**Decision:** Discover news cards store and display **only** the headline, source name, canonical link, and
(where licensed) an image. The publisher's `summary`/body text is **deliberately dropped** before the card is
built (`backend/finance/news.ts:289`; rationale comment `news.ts:1-12`).

**Why / alternative not taken:** re-displaying a publisher's article text — even a "summary" returned by a
free news API — is the free-tier-display trap: the API access does not grant a license to republish the
content. Headline + link-out is the defensible pattern (it's what aggregators do). Every card still carries
`commercialOk:false` provenance ([rules/commercial-ok-gate](../rules/commercial-ok-gate.md)).

**The transformative alternative we DO use elsewhere:** `research.ts` synthesizes an **original** note from
≥3 sources and cites + links out (`research.ts:1-9`) — that's transformative multi-source synthesis, a
different legal posture from republishing one article. Background memory: `discover-news-licensing`.
