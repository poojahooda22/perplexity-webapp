# Screeners & Scans — building a filter over the equity universe on this stack

> How to build a stock screener / scan in Lumina, and the hard truth first: **the current
> finance data path physically cannot feed one.** Every quote in
> [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) is a *per-request live
> fetch over a tiny hardcoded symbol list*; a screener filters *thousands* of tickers by
> server-side query over a *stored, indexed* table. Read this when a task says "screener", "scan",
> "stocks where RSI < 30 / P/E < 15 / % change > 5", "filter all stocks by X", or "top gainers across
> the market". This is a **project-grounded** ref — it cites the real fetchers and routes.
>
> Adjacent refs: finance `finance-at-scale-rscale.md` is the canonical R-SCALE battery (§A listing,
> §B search, §H ranking) — this doc is the screener-specific deep-dive that lands inside it, so cross-
> read both. For *where the bars come from* see `candlestick-and-ohlc.md`; for the provider/credit
> reality that makes the live path unscalable see finance `market-data-providers.md`; for the
> cache/budget mechanics see finance `caching-and-rate-budgets.md`; for the virtualized table UI shell
> see `charting-libraries-deep.md` + **lumina-frontend**.

---

## 1. What a screener actually is (and why the current path is the wrong shape)

A screener is **server-side filter + sort + paginate over a stored, indexed table**, then a
**virtualized** client table. Three properties, none of which the live-fetch path has:

| Screener needs | What `sources.ts` does today | Gap |
|---|---|---|
| Query a **stored** universe (~3k US / ~5k NSE+BSE rows) | Fetches a **hardcoded** 6-symbol list live per request (`DEFAULT_WATCHLIST`, `INDIA_WATCHLIST` in [`sources.ts`](../../../../backend/finance/sources.ts)) | There is no universe table; "all stocks" doesn't exist anywhere. |
| **Filter/sort on the server** by indexed columns | No filter — order = the literal array order of the constant | Can't filter what isn't stored. |
| **Paginate** (one page of N rows at a time) | Returns the whole (tiny) list every time | Nothing to paginate; the list is ~6 rows. |
| Per-row metrics: price, %chg, mcap, sector, P/E, volume… | `Quote` is `{symbol,name,price,change,changePercent,sparkline?}` (`Quote` type, [`sources.ts`](../../../../backend/finance/sources.ts)) — **no mcap, no sector, no P/E, no volume** | The fields a screener filters on aren't even fetched. |

**The blunt verdict (matches finance `finance-at-scale-rscale.md` §A): a screener is Tier 0 — it does
not exist, and it is a NEW surface, not a tweak to the cards.** Do not bolt it onto the per-request
live-fetch path. It needs a synced, indexed equity table fed by a *licensed bulk* provider.

---

## 2. Why the live-fetch path can't feed a screener — the credit math

The current fetchers are deliberately tiny **because of the free-tier budget**, not laziness. A
screener inverts every assumption that makes the tiny path work.

| Provider (in `sources.ts`) | Cost model | What a 3,000-ticker screen costs |
|---|---|---|
| **Twelve Data** (`fetchStocks`/`fetchQuotes`) | **1 credit PER symbol**, free cap **8 credits/min** (comment at `DEFAULT_WATCHLIST`, [`sources.ts`](../../../../backend/finance/sources.ts)); `fetchQuotes` hard-caps `.slice(0, 8)` | 3,000 credits → **~6.25 hours** of budget for ONE scan. Batching does NOT help (1/symbol). Impossible. |
| **Yahoo chart** (`fetchYahooQuote`) | Keyless, no documented cap — but **one HTTP request per symbol** (`fetchIndices`/`fetchSectors` do `Promise.all` over the list) | 3,000 parallel Yahoo requests per scan = an unofficial, uncontracted firehose that gets you rate-limited/blocked. Yahoo's chart API has no bulk/scan endpoint and no commercial-display license (`commercialOk:false` everywhere). |
| **CoinGecko** (`fetchCrypto`) | `coins/markets` IS a bulk/paginated list (`per_page`, `page`) — the *right shape* — but Demo tier is `commercialOk:false` | Crypto already has a list endpoint; equities do not. Still not display-licensed. |

So a screener over the per-request path is **N fetches per request, fanned out per symbol**, which is
exactly the §A / §B anti-pattern the trading-systems SKILL.md Non-Negotiable #7 forbids:

> "A screener cannot ride the per-request live-fetch path. Scanning thousands of symbols by fanning
> out N Yahoo/TD calls per request dies instantly."

Even the per-request **read-spike** protection (cache + in-flight de-dupe + stale-on-error in
[`backend/lib/cache.ts`](../../../../backend/lib/cache.ts)) doesn't save you: that caches *one key's*
result for many readers (§C). A screener's keyspace is the *cross-product of every filter combination*
— `price>100 AND sector=Tech AND %chg>2` is a different key from `price>50 AND sector=Energy` — so
cache hit-rate collapses and every novel filter is a cold full fan-out. Caching helps the read spike,
not the screen.

---

## 3. The correct architecture: a synced indexed equity table

A screener is a **read over your own database**, hydrated on a schedule from a licensed bulk source —
*not* a live multi-provider fan-out. The shape (Tier 2, the build finance R-SCALE §A prescribes):

```
 Nightly / intraday cron            Your DB (Prisma → Supabase Postgres)        Screener request
 ──────────────────────            ─────────────────────────────────────       ────────────────
 licensed BULK provider  ─sync─►   equity_snapshot                       ◄──── GET /finance/screener
 (e.g. FMP bulk-quote,             ( symbol PK, name, exchange, sector,         ?sector=Tech
  EOD bulk, or a paid                price, changePercent, marketCap,           &mcapMin=1e10
  Twelve Data plan)                 peRatio, volume, asOf )                     &chgMin=2
                                    INDEX (sector), (marketCap),                &sort=changePercent
   (off Vercel: cron-job.org        (price), (changePercent), (volume)         &page=0&limit=50
    → POST refresh, like the                  │
    existing cron warmer)                     └─ WHERE … ORDER BY … LIMIT … OFFSET ──► one page
```

The pieces, mapped to what already exists in the repo:

1. **A stored table** (`equity_snapshot`) in Prisma/Supabase Postgres — the universe + the metrics
   users filter on. This is the missing thing; today there is no DB table behind any finance read
   (`routes.ts` reads go straight to `sources.ts` via cache).
2. **A bulk hydrator** — a `fetchEquityUniverse()` fetcher in
   [`sources.ts`](../../../../backend/finance/sources.ts) that pulls a *bulk* endpoint (a full-market
   snapshot in one/few calls), each row carrying a `Provenance` like every existing fetcher. It writes
   to the table, it does not return a card payload.
3. **A scheduled refresh** — reuse the existing pattern: the cron warmer
   `POST /finance/cron/refresh` in [`routes.ts`](../../../../backend/finance/routes.ts) (the `jobs[]`
   array) already runs off an external scheduler (`cron-job.org`) because Vercel can't hold timers.
   Add a `["screener:sync", syncEquityUniverse]` job there.
4. **A server-side filtered route** — a NEW route (NOT `readRoute`/`marketReadRoute`, which are for
   fixed-key cached reads): it reads query params, builds a parameterized `WHERE`/`ORDER BY`/`LIMIT`,
   and returns one page. Filtering happens in the **DB query**, never in Node, never in the browser.
5. **A virtualized client table** — server sends 50 rows/page; the table renders only visible rows
   (see `charting-libraries-deep.md` / **lumina-frontend** for the virtualization shell).

### Decision framework — does this task need a screener build, or is it the tiny path?

```
"Filter / scan / screen stocks by <metric>" arrives
|
+-- Is the universe a FIXED, small (<~30) curated set?  (a watchlist, the indices, the sectors)
|     └─ YES → it's the existing card path. Extend the constant in sources.ts; live-fetch + cache is fine.
|              This is NOT a screener. (e.g. "add COST to the watchlist")
|
+-- Does it filter/sort an OPEN universe (all US / all NSE) by user-chosen criteria?
|     └─ YES → it's a real screener. STOP. You need §3: a stored indexed table + bulk sync + a
|              server-filtered paginated route + a virtualized table. Do NOT fan out per-symbol fetches.
|
+-- Is it "top gainers / top movers across the market"?
|     └─ That's a screener with ORDER BY changePercent + LIMIT — same build as above, NOT
|        `watchlist.sort(byChange)` (ranking 6 items is theatre; see finance R-SCALE §H).
|
+-- Does the filter need a derived TA value (RSI<30, above 50-day SMA, MACD cross)?
      └─ You must STORE the precomputed indicator per symbol per day (a column / sidecar table),
         computed in the sync job over real bars — you cannot compute RSI for 3k symbols live per
         request. See §6 + technical-indicators.md for the math (warmup, no repaint).
```

---

## 4. Server-side filtering — the indexing rule (R-SCALE §A #4)

Every filter a user actually uses must hit an **indexed column**, or each scan is a full-table scan —
reading every row of the table instead of using its index. The columns to index are exactly the
filterable metrics:

| Filter users ask for | Column | Index | Why |
|---|---|---|---|
| Sector / industry | `sector` | B-tree (or low-cardinality enum) | Most common facet; "all Tech stocks". |
| Market cap band | `marketCap` | B-tree | Range query (`>= 10e9`). |
| Price band | `price` | B-tree | Range query. |
| % change (movers) | `changePercent` | B-tree | `ORDER BY … DESC LIMIT 50` for top gainers/losers. |
| Volume / liquidity | `volume` | B-tree | Range + sort. |
| Exchange / market | `exchange` | B-tree | US vs NSE vs BSE split (matches the existing `Market` type). |

A composite index on the *common combination* (e.g. `(sector, changePercent)`) beats two single-column
indexes when both appear together. Pagination is `LIMIT :limit OFFSET :page*:limit` for Tier 2; switch
to **keyset/cursor pagination** (`WHERE (changePercent, symbol) < (:lastChg, :lastSym)`) at deep
offsets so page 200 isn't an O(N) scan.

```ts
// Sketch — the screener route's CORE (NOT readRoute; this one takes filters). Build the WHERE
// from validated query params; let Postgres + the indexes do the work. Returns ONE page.
financeRouter.get("/screener", financeRateLimit, async (req, res) => {
  const where = buildScreenerWhere(req.query);          // sector/mcapMin/priceMin/chgMin … → Prisma where
  const sort  = SAFE_SORTS[String(req.query.sort)] ?? { changePercent: "desc" }; // allowlist, never raw
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const page  = Math.max(Number(req.query.page) || 0, 0);
  const [rows, total] = await prisma.$transaction([
    prisma.equitySnapshot.findMany({ where, orderBy: sort, take: limit, skip: page * limit }),
    prisma.equitySnapshot.count({ where }),
  ]);
  res.json({ items: rows, total, page, asOf: rows[0]?.asOf ?? null, provenance: SCREENER_PROVENANCE });
});
```

Two non-negotiables in that sketch: **(a)** the sort key is an **allowlist** (`SAFE_SORTS`), never the
raw query string interpolated into `ORDER BY` (injection + unindexed-sort surface); **(b)** the row's
`asOf` is surfaced so the UI shows the snapshot age — a screener over a nightly table is *delayed by
construction*, and per SKILL.md Non-Negotiable #6 you must state the as-of time and never label it
live.

---

## 5. Client side — virtualization & pagination (§A #1, #3)

| §A question | Wrong (Tier-1-believing-it's-Tier-3) | Right |
|---|---|---|
| 1. How many rows in client memory? | Ship all 3k matched rows and slice in JS | Hold only the current page (≤100 rows). |
| 2. Where does filter/sort happen? | `rows.filter(...).sort(...)` in the browser | In the DB query (§4). The client only *requests* filters. |
| 3. Paginated + virtualized? | One `<table>` with 3k `<tr>` | Server sends 50/page; virtualize so only visible rows mount (`@tanstack/react-virtual`). |
| 5. Does the IA assume "browse the list"? | A single scrollable mega-list | At 3k+ tickers nobody browses — lead with sector facets + filters + search, then a paged result. |

Debounce filter changes (~250ms) before refetching, exactly like the ticker-search guidance in finance
R-SCALE §B — every keystroke must not fire a query. Use a TanStack Query key that includes the full
filter set (`["finance","screener", filters, page]`) so each page/filter combo caches independently and
back-navigation is instant.

---

## 6. Filtering on a technical indicator (RSI<30, above SMA50)

A TA filter is a screener filter whose column is a **precomputed indicator**, not a raw field. You
cannot compute RSI for the whole universe live per request — that's the §2 fan-out times an indicator
loop. Instead:

1. In the **sync job**, for each symbol pull the real close array (the same
   `result.indicators.quote[0].close` that `fetchYahooQuote` already reads, [`sources.ts`](../../../../backend/finance/sources.ts):292), and compute the indicator with the standard
   warmup rule from `technical-indicators.md` — RSI-14 is `null` until bar 14; **never repaint** a
   closed bar.
2. Store the latest value (`rsi14`, `sma50`, `aboveSma50` boolean) as a column on `equity_snapshot`,
   indexed if it's a common filter.
3. The screener route filters on the stored column (`WHERE rsi14 < 30`) — a normal indexed read.

This keeps SKILL.md Non-Negotiables #2 (real bars, never fabricated), #5 (warmup/no-repaint), and #7
(no per-request fan-out) all satisfied at once: the heavy work is batched into the off-Vercel sync job,
the request is a cheap indexed query.

---

## 7. Licensing — a screener is a display surface (SKILL.md NN #1, finance `data-licensing`)

Every existing fetcher returns `commercialOk:false` (`cgProvenance`/`tdProvenance`/the inline Yahoo
provenances in [`sources.ts`](../../../../backend/finance/sources.ts)). A screener **displays
thousands of rows publicly**, so the licensing gate matters *more*, not less:

- The bulk source feeding `equity_snapshot` must carry a **commercial-display license** before the
  screener launches publicly — a free tier that "works technically" is still `commercialOk:false`
  (SKILL.md NN #6 / finance market-data-providers). Yahoo's keyless chart path is unofficial and
  uncontracted for scan volume — fine for the demo cards, **not** a basis for a public screener.
- The screener's response carries a `Provenance` like every other payload, and the UI renders the
  attribution string + the `asOf` snapshot time. A screener over delayed nightly data labeled "live"
  is the exact honesty failure NN #6 forbids.

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Building a screener that fans out a Yahoo/Twelve Data call **per symbol per request**. | Sync a stored, indexed `equity_snapshot` table nightly from a licensed *bulk* provider; the request is one DB query. |
| Calling `fetchQuotes`/`getQuote` in a loop over a big symbol list to "scan". | `fetchQuotes` hard-caps `.slice(0,8)` for a reason — 1 TD credit/symbol, 8/min. It is a point lookup, never a scanner. |
| `equity_snapshot.findMany()` with no `where`/`take`, then `rows.filter().sort()` in Node or the browser. | Push the filter/sort/limit into the **DB query** over **indexed** columns; return one page. |
| Interpolating `req.query.sort` straight into `ORDER BY`. | Allowlist sort keys (`SAFE_SORTS`); reject anything else. Prevents injection + accidental unindexed sorts. |
| `LIMIT/OFFSET` at deep pages (`OFFSET 10000`). | Keyset/cursor pagination (`WHERE (sortcol, id) < (:last…)`) so deep pages stay O(page), not O(N). |
| Unindexed filter columns ("it works on 1k rows in dev"). | Index `sector`, `marketCap`, `price`, `changePercent`, `volume`, `exchange` — an unindexed filter is a full-table scan. |
| `"top movers" = watchlist.sort(byChangePercent)`. | Ranking 6 hardcoded symbols is theatre. Movers rank the **whole universe**: `ORDER BY changePercent DESC LIMIT 50` over the table (finance R-SCALE §H). |
| Computing RSI/SMA for the universe live in the screener request. | Precompute the indicator in the sync job over real bars (warmup, no repaint), store it as an indexed column, filter on the column. |
| Caching the screener like the cards (one `getOrRefresh` key). | The filter cross-product makes per-key caching useless; cache the *snapshot table* freshness, query it live per filter. (Edge-cache only truly hot fixed filters, e.g. "today's top gainers".) |
| Shipping the screener over the free path and flipping `commercialOk:true` because "the API returned data". | The bulk source needs a commercial-display license; surface `Provenance.attribution` + the `asOf` snapshot age; never label nightly data "live". |
| Believing the screener "renders fast" in dev = it's production-ready. | Dev has 50 demo rows. State the tier: screener is a Tier-2 build; name what breaks at 10k rows and at the open-bell spike. |

---

## 9. The one-screen verdict (tier table for the screener surface)

| Aspect | 1× (today) | 100× (the real build) | 10,000× |
|---|---|---|---|
| **Existence** | Does NOT exist — only fixed curated cards | DB-backed `equity_snapshot`, server-filtered, indexed, paginated, virtualized | + search-engine-backed facets, ranking by stored signals |
| **Data source** | Per-request live fetch, ≤8 TD credits | Nightly **bulk** sync from a licensed provider into the table | Intraday delta sync; CDN/edge in front of hot fixed filters |
| **Filter location** | None (array order) | Server DB query over indexed columns | + keyset pagination, materialized hot-filter views |
| **TA filters** | None | Precomputed indicator columns from the sync job | + multi-timeframe precompute |
| **Licensing** | `commercialOk:false`, demo only | Bulk source with **commercial-display license** | same, enforced |
| **Current tier** | **Tier 0 — absent by design** | **Needs a Tier-2 build (§3)** | deliberate graduation |

**Bottom line:** a screener is not a bigger watchlist — it is a different system (stored indexed table
+ server-side filtered query + pagination + virtualization), and the per-request live-fetch path in
[`sources.ts`](../../../../backend/finance/sources.ts) cannot become one. When a task asks for a
screener, build the Tier-2 version deliberately, name the tier, and write down what breaks at 10k
rows — exactly the discipline finance `finance-at-scale-rscale.md` §A prescribes.
