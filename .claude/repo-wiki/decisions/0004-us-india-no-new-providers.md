---
title: "ADR 0004 — US/India markets via the existing provider stack"
kind: decision
owning_skill: finance-markets
cites:
  - backend/finance/sources.ts
  - backend/finance/routes.ts
fresh: 2026-06-22
---

# ADR 0004 — US/India switcher rides the existing providers (zero new vendors)

**Decision:** the US/India market switcher adds **no new data provider**. India indices/sectors and India
stocks ride the **Yahoo chart API** (already used for US indices/sectors), while US stocks use Twelve Data.
Routing is by a `?market=in` query param handled by `marketReadRoute` (`backend/finance/routes.ts:44,50`),
which keys India cache entries under `finance:in:<name>`.

**Why / alternative not taken:** Twelve Data's **free tier excludes NSE/BSE** (`backend/finance/sources.ts:271,412`),
so India stocks fall to Yahoo (`fetchStocks` India path `sources.ts:415`). Adding a dedicated India provider
(e.g. a paid NSE feed) was rejected — the existing free stack already covers both markets, keeping the
licensing posture uniform (all `commercialOk:false`) and avoiding new keys/cost. Background memory:
`india-markets-kb`.

**Consequence:** the cron warmer refreshes both US and India keys (`routes.ts:96`); India and US series have
the same provenance/licensing treatment.