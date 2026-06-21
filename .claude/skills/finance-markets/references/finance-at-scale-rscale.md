# Finance at Scale (R-SCALE)

> The user's R-SCALE battery applied to Lumina's finance surfaces — watchlist, screener, ticker
> search, movers, research ranking, and the market-open read spike. Read this **before** you build
> or extend any list/search/ranking surface in finance, so you ship Tier 1 *knowing* it's Tier 1
> instead of believing it's Tier 3. For the data plumbing it scales over see
> `lumina-finance-architecture.md`; for the cache/budget mechanics see `caching-and-rate-budgets.md`;
> for provider limits (which *cause* the current tier) see `market-data-providers.md`.

This is a mostly-generic R-SCALE doc, but every "current tier" claim is grounded in our live code:
[`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) and
[`backend/finance/routes.ts`](../../../../backend/finance/routes.ts).

---

## The three tiers (the global rule, restated for finance)

| Tier | Load | Finance reality |
|---|---|---|
| **1×** | demo data, ~1 user | 6 hardcoded watchlist symbols, 4 indices, 11 sectors, top-12 crypto. One person clicking around. |
| **100×** | early traction | thousands of users, a *user-defined* watchlist per account, a real screener over the full US/India equity universe (~10k tickers), typeahead ticker search. |
| **10,000×** | the product working | lakhs of concurrent users at the 9:30 ET open, every ticker page indexable, movers/research ranked by behavioral signals, paper-trading or alerts under contention. |

**The failure this rule prevents:** Tier-1 finance code feels correct because 6 symbols always fit
in memory and always render fast. Every scale break (frozen screener, useless search, sale-day-style
open-bell crash, a paper-trade that double-fills) is invisible until real load arrives. Ask the
battery now; it costs minutes. Retrofitting indexes, pagination, a search engine, and atomic writes
after launch costs the launch.

---

## §A — Listing / Browse: the watchlist + the (future) screener

**What's a list surface here:** the watchlist (`fetchStocks`), indices (`fetchIndices`), sectors
(`fetchSectors`), crypto (`fetchCrypto`), predictions (`fetchPredictions`). Today they are **fixed,
tiny, server-curated arrays** — the right Tier-1 call, and *not* a screener.

The current watchlist is a hardcoded 6-symbol constant — `DEFAULT_WATCHLIST = ["GOOGL","NVDA","TSLA",
"META","AAPL","AMZN"]` in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) (in
`fetchStocks`). India is the 6-symbol `INDIA_WATCHLIST`; indices/sectors are the `YAHOO_INDICES` /
`SECTOR_ETFS` / `INDIA_SECTORS` constants. **This is by design, not laziness:** the size is dictated
by Twelve Data's free tier — 8 credits/min, **1 credit per symbol**, batching doesn't help — so 6
symbols on a 300s TTL is the budget (see `market-data-providers.md`). It is genuinely Tier 1.

Now run the battery against it, and against the screener that 100×/10000× will demand:

| §A question | Today (Tier 1) | Breaks at 100× / 10000× |
|---|---|---|
| 1. How many items in client memory at once? | All of them — but "all" is ≤ ~30 rows. Fine. | A real screener over ~10k US tickers (let alone all-markets) cannot ship the array to the client. |
| 2. Where does filter/sort happen? | Nowhere — there is no filter. Order = the hardcoded array order. | A screener filters/sorts on the **server with a DB query** (price, mcap, sector, % change), never in the browser. |
| 3. Paginated + virtualized? | No — the whole tiny list renders. | Server sends one page (e.g. 50 rows) at a time; the table virtualizes (render only visible rows). |
| 4. Which DB columns are indexed for the filters users use? | N/A — no DB; data is fetched live per request and cached by key. | Index `sector`, `marketCap`, `price`, `changePercent`, `exchange`. An unindexed screener filter = full-table scan. |
| 5. Does the IA assume "browse the list"? | Yes, and that's correct at 30 rows. | At 10k+ tickers nobody browses — they use category (sector) tree + facets + search. The IA must shift. |

**Verdict (listing):** the watchlist/cards are **solid Tier 1** and appropriate. There is **no
screener today**. A screener is a *new* surface — do not bolt it onto the per-request live-fetch
path. It needs a stored, indexed equity universe (a nightly-synced table), server-side filtered
queries, pagination, and a virtualized table. That table can be hydrated from a Tier-2 provider with
a display license — the free Twelve Data path cannot feed a 10k-row screener (it would be 10k
credits) and Yahoo's keyless path is unofficial and uncontracted for that volume.

---

## §B — Search: ticker / company typeahead

**Current state: there is no ticker search.** Nothing in
[`sources.ts`](../../../../backend/finance/sources.ts) or
[`routes.ts`](../../../../backend/finance/routes.ts) resolves a free-text query like "appl" or
"reliance" to a symbol. The finance **chat agent** can answer "price of MSFT" via `getQuote`
(parameterized `fetchQuotes`), but that already requires the user to know the ticker — it is not a
search box, and the model picking a symbol is not an indexed lookup. So search is **Tier 0** (absent)
heading for Tier 1.

| §B question | Tier 1 (what to ship first) | Tier 2 | Tier 3 |
|---|---|---|---|
| 6. Exact / prefix / fuzzy? | Client-side fuzzy over a bundled symbol+name list (Fuse.js / MiniSearch). "samsng" → Samsung; "reliance" → RELIANCE.BO. | DB prefix + trigram (`pg_trgm`) over a synced symbol table. | Dedicated engine (Typesense/Meilisearch/Algolia class) with typo tolerance + ranking. |
| 7. Debounced? | Yes — fire ~250ms after typing stops, never per keystroke. | same | same |
| 8. Where does it run? | In the browser over the in-memory ticker list (a few thousand entries is fine to ship). | Postgres FTS + `pg_trgm` index. | Inverted index in a search engine. |
| 9. How ranked? | Exact-symbol-match first, then prefix, then name contains. | + popularity / market-cap weight. | full ranking (see §H). |
| 10. Autocomplete? | Same client list, prefix-filtered. | Separate prefix index. | Dedicated suggest index. |

**Verdict (search):** ship the **Tier-1 client-side fuzzy** symbol search first — a static
`symbols.json` (symbol, name, exchange, market) bundled or served once, searched with MiniSearch,
debounced. It covers thousands of tickers with zero new infra and zero provider credits. Graduate to
`pg_trgm` only when the universe is too big to bundle or you need cross-field weighting, and to a
search engine only at true scale. Do **not** wire the chat agent's `getQuote` as your search box —
that burns Twelve Data credits per attempt and is not a lookup.

---

## §H — Matching vs Ranking: movers, top-gainers, research

> Every real search/feed is a **ranking** system. R-SCALE §H: search has two halves — **matching**
> (which items qualify) and **ranking** (what order they appear). Tier-1 ships only matching. Every
> production finance feed (Yahoo's trending, a screener's "top gainers", a research carousel) is
> dominated by ranking.

**Current state — order is array order.** Look at the code:

- Watchlist/indices/sectors render in the **literal constant order** of `DEFAULT_WATCHLIST` /
  `YAHOO_INDICES` / `SECTOR_ETFS` in [`sources.ts`](../../../../backend/finance/sources.ts) — no
  ranking, just authored order.
- Crypto uses `order=market_cap_desc` in `fetchCrypto` — a **provider-side** rank (market cap), which
  is fine and honest, but it's the *only* ranked feed.
- Predictions use `order=volume24hr&ascending=false` in `fetchPolymarket` — again a provider-side
  sort, not ours; Manifold falls back to `sort=score`.
- **There are no "top movers / top gainers" on our side.** If you add them, the naive version is
  "sort the watchlist by `changePercent`" — that's ranking 6 items, which is meaningless. Real movers
  rank the *whole universe*, which is the same problem as the screener.
- Research ([`backend/finance/research.ts`](../../../../backend/finance/research.ts)) and the Discover
  carousel order items by **category iteration order** — pure matching, zero ranking.

| §H question | Today | What production needs |
|---|---|---|
| 25. Matching vs ranking? | Matching only (array/category order); crypto+predictions borrow the provider's sort. | An explicit **ranking function** for movers, screener results, and research. |
| 26. Text-relevance scoring (for search/research)? | None. | Title hit > body hit; exact > partial (BM25/TF-IDF class) once you have a search engine. |
| 27. Behavioral signals stored? | **None captured.** We never log a click, a watchlist-add, a ticker-page view, or a research-card open. | Instrument from day one: store per-ticker click-through, watchlist-adds, page views, dwell. Production rank = text relevance × signals (volume, % move magnitude, click-through, in-watchlist count, news freshness). **If you never store the signal you can never rank by it.** |
| 28. Seller/content SEO side? | N/A — we author the universe; no third party lists into our search. | If listings ever become user/partner-supplied, enforce structured fields and defend against keyword stuffing. |
| 29. External SEO (Google can index)? | Finance is an SPA today — **invisible to Google**. No per-ticker crawlable URL. | At scale, pair the app with indexable per-ticker web pages (crawlable URL, title, meta, schema.org `Product`/financial markup) so quotes/research appear in web search. |

**Verdict (ranking):** today's array order is honest Tier 1 — but the moment you add **movers** or a
**screener** you are building a ranking system whether you admit it or not. The cheap, high-leverage
move now is **#27: instrument behavioral signals before you need them.** Add a tiny event log
(ticker viewed, watchlist add, research opened) even while the feeds stay array-ordered. Ranking can
come later; the signals cannot be backfilled.

---

## §C — Read spike: the market open (and our cache *is* the answer)

The 9:30 ET open (and any viral ticker moment) is exactly R-SCALE §C — a read spike on cacheable
data. **Good news: Lumina already implements the §C pattern correctly for Tier 1–2.** Reads are
*computed once and served to many* — "print the flyer, don't hand-write each user's copy":

- Every public read goes through `getOrRefresh(key, ttl, fetcher)` in `readRoute` /
  `marketReadRoute` in [`backend/finance/routes.ts`](../../../../backend/finance/routes.ts). A cache
  HIT serves without touching a provider — so 10,000 concurrent `/finance/home` hits in the same TTL
  window cost **one** upstream fetch, not 10,000.
- The cache has **in-flight de-dupe** (one shared fetch per key — the thundering herd at TTL expiry
  collapses to a single upstream call) and **stale-on-error** (a provider hiccup at the open serves
  the last good value, never a 500). See `caching-and-rate-budgets.md`.
- The **cron warmer** (`POST /finance/cron/refresh`) pre-warms every key (US + India) on a schedule,
  so the first user after a TTL lapse never pays the cold fetch — including the expensive LLM-backed
  `summary`. This is the "compute-once" half done proactively.
- `/home` fans out with `Promise.allSettled`, so one slow series degrades to `null`, not a hung page.

| §C question | Today | Gap at 10000× |
|---|---|---|
| 11. What's cached, where? | Every series in Upstash Redis (or in-process Map fallback), keyed `finance:*` / `finance:in:*`, with soft+hard TTL. | Add a **CDN/edge** layer in front of `/finance/*` (these are public, unauth GETs — ideal for edge caching) so reads never even reach the function. |
| 12. Read capacity scales without touching writes? | Cache mostly decouples reads from providers. | True read scale = CDN + Redis read; the provider write path is already a single shared fetch. |
| 13. Graceful degradation under overload? | Yes — stale-served on error, `null` per-series, 502 only when nothing's ever been cached. | Serve stale-but-cached browse pages indefinitely under provider outage; never let the open bell take the page down. |

**Two real caveats:** (1) the **in-process Map** cache is per-instance and cold-start-wiped — on
Vercel serverless that means each cold function recomputes; you **must** set `UPSTASH_*` before a
real launch so the hot cache is shared (noted in `lumina-finance-architecture.md`). (2) The crypto
TTL is 30s and live ticks come from the `worker/` WebSocket, *not* these routes — the spike pattern
for genuinely-live prices is the Realtime fan-out, see `realtime-prices-websocket.md`.

**Verdict (read spike):** the cache + de-dupe + stale-on-error + cron-warm stack is the **correct
§C answer** and is the strongest-scaling part of the finance vertical. To reach true 10000×, add a
CDN/edge cache in front of the public read routes and ensure shared Redis is on.

---

## §D / §E / §G — Contested writes: mostly N/A today (watch this space)

Market data is **read-only**, so the contested-write battery (§D atomic guarded decrement, §E queue
ordering, §G order pipeline) is **not applicable to anything Lumina ships today** — there is no
inventory, no balance, no seat. Don't invent atomicity where there's nothing being claimed.

**But the moment finance gains a *write* surface, this section turns on hard.** Two realistic
additions:

- **Paper-trading / a portfolio with cash.** A user's cash balance is the fintech equivalent of
  contested inventory: two simultaneous "buy" taps must not both succeed against the same balance.
  The fill must be one atomic guarded statement —
  `UPDATE portfolio SET cash = cash - :cost WHERE id = :id AND cash >= :cost` — never read-then-write
  in app code. Every retried/double-tapped order needs an **idempotency key** so a network retry
  doesn't place two trades or debit twice.
- **Price/threshold alerts.** Lower-stakes, but a fired alert must be **idempotent** (fire once per
  crossing, not once per evaluation tick) and the evaluation loop belongs in the `worker/` (off
  Vercel, like the WS), not a serverless route.

| §D/§G question | When it applies | The mechanism (learn it, not the sector) |
|---|---|---|
| 14–15. When is the resource claimed, and is the decrement atomic+guarded? | paper-trade fill, alert-slot | one `UPDATE … WHERE balance >= cost` row-lock; the DB row is the single ticket window. |
| 17. Idempotency on retry? | every order/alert write | idempotency key per attempt; a duplicate request is a no-op. |
| 22–24. Split into states + compensating action? | a real (non-paper) order pipeline | PLACED → PENDING → CONFIRMED, heavy work async off a queue; refund/restock on failure. |

**Verdict (writes):** N/A for the current read-only product — correctly so. If/when paper-trading or
alerts land, **do not** treat them as "just another fetcher." They are write surfaces: atomic guarded
updates + idempotency keys + (for alerts) the `worker/`. Re-read §D/§G of the global rule then.

---

## Per-feature tier table (the one-screen verdict)

| Feature | 1× (today) | 100× | 10000× | Current tier |
|---|---|---|---|---|
| **Watchlist / cards** | 6 hardcoded symbols, live-fetch + cache, array order | per-user watchlist stored in DB; still small per user | per-user lists at scale; reads from CDN/Redis | **Tier 1 — correct** |
| **Screener** | does not exist | DB-backed, server-filtered, indexed, paginated, virtualized; needs a licensed bulk provider | + search-engine-backed facets, edge cache | **Tier 0 → needs Tier 2 build** |
| **Ticker search** | does not exist | client-side fuzzy (MiniSearch) over bundled symbols, debounced | `pg_trgm` → dedicated search engine, ranked | **Tier 0 → ship Tier 1 client-fuzzy** |
| **Movers / top gainers** | does not exist | rank full universe server-side by % move + volume | ranking fn × stored signals; edge-cached | **Tier 0 → it's a ranking system, see §H** |
| **Research / discover feed** | category-order, LLM+Tavily, 6h cache | + behavioral ranking signals captured | ranked feed, indexable web pages | **Tier 1 (matching only)** |
| **Indices / sectors / crypto / predictions** | small curated/provider-sorted, cached | same + CDN | edge + Realtime for live | **Tier 1 — correct** |
| **Market-open read spike** | cache + in-flight de-dupe + stale-on-error + cron warm | + shared Redis (must enable) | + CDN/edge in front of `/finance/*` | **Tier 1–2 — strongest** |
| **Paper-trade / alerts (writes)** | N/A | atomic guarded write + idempotency | + queue, state machine, compensation | **N/A (turns on when added)** |

---

## Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Shipping a screener over the full equity universe through the per-request live-fetch + Twelve Data path. | Sync a stored, indexed equity table (nightly, from a licensed bulk provider); filter/sort/paginate server-side; virtualize the table. |
| Building ticker search by calling the chat agent's `getQuote` per query. | Static `symbols.json` + client-side fuzzy (MiniSearch), debounced ~250ms. Zero credits, zero infra. |
| Filtering/sorting a 10k-row list in the browser. | Server-side DB query against **indexed** columns (`sector`, `marketCap`, `changePercent`); send one page at a time. |
| Adding "top movers" as `watchlist.sort(byChange)`. | Ranking 6 items is theatre. Movers rank the whole universe — that's the screener problem; and it's §H ranking, so capture signals. |
| Believing the cards are Tier 3 because they "always render fast." | They render fast because they're 30 rows. State plainly: watchlist = Tier 1, screener/search/movers don't exist yet. |
| Deferring behavioral-signal logging until "we need ranking." | Instrument clicks/adds/views **from day one** — signals can't be backfilled (§H #27). |
| Treating a future paper-trade fill as another fetcher. | It's a contested write: atomic guarded `UPDATE … WHERE balance >= cost` + idempotency key. Never read-then-write. |
| Launching with the in-process Map cache on serverless. | Set `UPSTASH_*` for a shared hot cache, or every cold start recomputes and the §C spike pattern silently degrades. |
| Assuming Google can find a ticker's data. | The SPA is invisible to crawlers — at scale add indexable per-ticker pages with schema.org markup (§H #29). |

---

## The blunt verdict

Lumina's finance vertical is **honest Tier 1, with a Tier-1–2 read-spike layer** — and that is the
*right* place for a portfolio-grade product to be. The watchlist, indices, sectors, crypto, and
predictions are correctly small, correctly cached, and correctly served. The cache + de-dupe +
stale-on-error + cron-warm stack is genuinely good §C engineering.

What does **not** exist yet — screener, ticker search, movers, signal-based ranking, write surfaces —
is exactly where teams accidentally ship Tier 1 while believing it's Tier 3. So when a task asks for
any of those: build the Tier-1 version deliberately (client-fuzzy search, signal logging), name the
tier in the plan, and write down what breaks at the next one. The two no-regret moves available
today, with no new infra, are **(a) instrument behavioral signals now** and **(b) confirm shared
Redis is on before any real launch.** Everything else is a deliberate, planned graduation — not a
surprise incident at the open bell.
