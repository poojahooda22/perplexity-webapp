# US / India Markets — one param, two markets

> How Lumina's Finance vertical serves two markets (US default, India via `?market=in`) from the
> SAME stack — zero new providers, zero new keys. The whole thing is a single `Market` switch
> threaded through the existing fetchers + cache keys. This doc is the map for adding or changing a
> market, the India symbol maps, why India rides keyless Yahoo, currency/unit handling, and a
> step-by-step "add a new market" checklist. Pair with `market-data-providers.md` (the provider
> limits that force these choices) and `data-licensing-and-compliance.md` (why everything stays
> `commercialOk:false`). `lumina-` = THIS codebase; cite the live file before changing it.

---

## 1. The mental model: a market is a parametrization, not a new integration

India is **not** a new provider stack. The market-data layer is already global — Yahoo's chart API
returns INR for `.NS`/`.BO` symbols and points for `^NSE*` indices; CoinGecko takes a `vs_currency`;
Tavily/the LLM take any query. So a "market" is just **which symbol list + which currency** a fetcher
reads, plus a **separate cache key** so the two never collide.

```
GET /finance/indices            → fetchIndices("us")  → YAHOO_INDICES  → finance:indices
GET /finance/indices?market=in  → fetchIndices("in")  → INDIA_INDICES  → finance:in:indices
```

The contract is one type:

```ts
export type Market = "us" | "in";   // sources.ts
```

Every market-aware fetcher takes `market: Market = "us"` (US is the default everywhere — an absent
or unknown `?market` falls back to US). See [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)
(`fetchIndices`, `fetchStocks`, `fetchSectors`) and the `marketReadRoute` helper in
[`backend/finance/routes.ts`](../../../../backend/finance/routes.ts).

**What is market-aware:** indices, stocks (watchlist), sectors, market summary, discover news.
**What stays global / marketless by design:** crypto (CoinGecko, USD) and predictions
(Polymarket→Manifold, USD/mana). Those use the keyless `readRoute`, not `marketReadRoute`.

---

## 2. The India symbol maps (the heart of it)

All four India lists live in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts).
Every value was **live-verified to match a reference India tab** (NIFTY 50 ≈ 24,013.1 −0.64%,
RELIANCE ≈ ₹1,309.35) — do not "tidy" a ticker without re-verifying it returns data from Yahoo.

### `INDIA_INDICES` (Top Assets) — keyless Yahoo, INR/IST

| Symbol | Name | Note |
|--------|------|------|
| `^NSEI` | NIFTY 50 | the headline index |
| `^BSESN` | S&P BSE Sensex | BSE benchmark |
| `^NSEBANK` | Nifty Bank | |
| `^CNXIT` | Nifty IT | also appears in `INDIA_SECTORS` |

US counterpart `YAHOO_INDICES` = `^GSPC ^IXIC ^DJI ^VIX`. `fetchIndices(market)` just picks the
list: `const list = market === "in" ? INDIA_INDICES : YAHOO_INDICES;`.

> **Ticker trap:** `^NSMIDCP` is "Nifty NEXT 50", **not** midcap — never infer an index from its
> ticker string. `^CRSLDX` = Nifty 500, `^CNX100` = Nifty 100 if you ever extend the list.

### `INDIA_WATCHLIST` (company stocks) — Yahoo `.NS`/`.BO`, INR

| Symbol | Name | Exchange |
|--------|------|----------|
| `RELIANCE.BO` | Reliance Industries | `.BO` = BSE |
| `TATATECH.NS` | Tata Technologies | `.NS` = NSE |
| `ICICIGI.NS` | ICICI Lombard | NSE |
| `INFY.NS` | Infosys | NSE |
| `TCS.NS` | TCS | NSE |
| `HDFCBANK.NS` | HDFC Bank | NSE |

`.NS` = NSE, `.BO` = BSE. Pick the suffix to **match the reference exchange label** (the reference
tab shows "RELIANCE · BSE" → `.BO`). The suffix is stripped for display (see §4).

### `INDIA_SECTORS` (Equity Sectors) — NSE sectoral indices, shown as POINTS

```
^CNXIT (Nifty IT)        ^NSEBANK (Nifty Bank)    ^CNXAUTO (Nifty Auto)
^CNXFMCG (Nifty FMCG)    ^CNXPHARMA (Nifty Pharma) ^CNXMETAL (Nifty Metal)
^CNXENERGY (Nifty Energy) ^CNXFIN (Nifty Fin Svcs) ^CNXREALTY (Nifty Realty)
^CNXMEDIA (Nifty Media)   ^CNXINFRA (Nifty Infra)
```

This is the one place US and India diverge in **render type**, not just symbols (see §5). US sectors
are the 11 SPDR Select Sector ETFs (`XLK`, `XLE`, …) with tradeable **$ prices**; India sectors are
NSE sectoral **indices** with **point values**.

---

## 3. Why India rides KEYLESS Yahoo for stocks/indices/sectors

The US watchlist uses Twelve Data (`/quote`); **India cannot.** Twelve Data's free tier **excludes
NSE/BSE** entirely — India equities are a paid Grow+ plan ($29/mo) and only EOD even then. So all
three India equity surfaces (indices, stocks, sectors) route through the **same keyless Yahoo chart
API** that US indices already use — `fetchYahooQuote(symbol, name)`.

| Surface | US provider | India provider | Why the difference |
|---------|-------------|----------------|--------------------|
| Indices | Yahoo (`^GSPC`…) | Yahoo (`^NSEI`…) | same path; TD free 404s on raw indices anyway |
| Watchlist stocks | **Twelve Data** | **Yahoo** (`.NS`/`.BO`) | TD free excludes NSE/BSE; Yahoo returns INR natively |
| Sectors | Yahoo (SPDR ETFs) | Yahoo (`^CNX*`) | same path, different symbols + render type |

Yahoo wins for India on every axis that matters here: **free, no credit limit, returns INR natively,
reachable from India, and returns real index points** — exactly the gaps Twelve Data's free tier
leaves. This is why `fetchStocks("in")` branches to Yahoo at the top of the function before it ever
touches `twelveKey()`:

```ts
// fetchStocks() in sources.ts
if (market === "in") {
  const items = (await Promise.all(INDIA_WATCHLIST.map((s) => fetchYahooQuote(s.symbol, s.name))))
    .filter((q): q is Quote => q !== null)
    .map((q) => ({ ...q, symbol: q.symbol.replace(/\.(NS|BO)$/i, "") }));  // strip suffix
  return { items, provenance: { source: "Yahoo Finance", commercialOk: false,
    attribution: "India stock data via Yahoo Finance (delayed)" }, currency: "INR" };
}
// ...US path: twelveKey() → Twelve Data /quote
```

`fetchYahooQuote` is shared verbatim between US and India — same daily-change logic (previous close =
`closes[len-2]`, **not** `meta.chartPreviousClose`), same 8s timeout, same per-symbol `null` on
failure. See `fetchYahooQuote` and `fetchIndices`/`fetchSectors`/`fetchStocks` in
[`sources.ts`](../../../../backend/finance/sources.ts).

---

## 4. The `.NS`/`.BO` suffix strip (display)

Yahoo needs the exchange suffix to resolve the symbol (`TATATECH.NS`), but the user should see
`TATATECH`. Only `fetchStocks("in")` strips it — indices and sectors keep their `^…` symbols (those
aren't shown raw to users; the curated `name` label is). The strip is a single regex on the way out:

```ts
.map((q) => ({ ...q, symbol: q.symbol.replace(/\.(NS|BO)$/i, "") }))
```

> **Do NOT strip before the fetch.** Yahoo will 404 a bare `TATATECH`. Fetch with the suffix, display
> without it. The strip is case-insensitive and anchored (`$`) so it can't clip a legitimate inner
> string.

---

## 5. Currency + units: INR vs USD, points vs $

Every market-aware payload carries a `currency` field on `QuotesPayload`:

```ts
export type QuotesPayload = {
  items: Quote[]; provenance: Provenance; needsKey?: boolean;
  currency?: "USD" | "INR";
};
```

`fetchIndices`/`fetchSectors` set `currency: market === "in" ? "INR" : "USD"`; `fetchStocks("in")`
hardcodes `"INR"`. The frontend turns that into the display: a `money(n, currency)` formatter
(`n.toLocaleString(currency === "INR" ? "en-IN" : "en-US", …)`) — `en-IN` gives the ₹ symbol and
lakh/crore grouping for free.

**The render-type divergence (sectors):** US sector cards show SPDR ETF **$ prices** (formatted with
`usd()`); India sector cards show index **points** (formatted with `num()` — a plain number, no
currency glyph). Same `Quote` shape, different formatter chosen by market on the frontend. If you add
a market whose "sectors" are indices (most are), it must use the points/`num()` render, not `$`.

| Surface | US render | India render |
|---------|-----------|--------------|
| Indices | points (`num`) | points (`num`), INR context |
| Watchlist | `usd()` | `money(n,"INR")` → ₹, lakh/crore |
| Sectors | `usd()` (ETF $ price) | `num()` (index points) |

Crypto stays USD globally by design (CoinGecko `vs_currency=usd`); a future per-market crypto would
flip `vs_currency=inr` and cache `us`/`in` separately so currency doesn't bleed.

---

## 6. Separate `finance:in:*` cache keys via `marketReadRoute`

US and India MUST never share a cache entry — otherwise one market's data overwrites the other's. The
isolation is the cache-key namespace, built in `marketReadRoute` in
[`routes.ts`](../../../../backend/finance/routes.ts):

```ts
function marketReadRoute(name, ttl, fetcher) {
  return async (req, res) => {
    const market: Market = req.query.market === "in" ? "in" : "us";       // US default
    const key = market === "in" ? `finance:in:${name}` : `finance:${name}`; // namespace
    const r = await getOrRefresh(key, ttl, () => fetcher(market));
    res.json({ ...(r.data as object), fetchedAt: r.fetchedAt, stale: r.stale });
  };
}
```

So `/finance/indices` → `finance:indices`, `/finance/indices?market=in` → `finance:in:indices`. The
US key path is byte-for-byte what it was before India existed (no migration). Routes wired through
`marketReadRoute`: **indices, stocks, sectors, summary, discover**. Routes that stay marketless go
through the plain `readRoute`: **crypto, predictions, research**.

| Route | Helper | US key | India key |
|-------|--------|--------|-----------|
| `/finance/indices` | `marketReadRoute` | `finance:indices` | `finance:in:indices` |
| `/finance/stocks` | `marketReadRoute` | `finance:stocks` | `finance:in:stocks` |
| `/finance/sectors` | `marketReadRoute` | `finance:sectors` | `finance:in:sectors` |
| `/finance/summary` | `marketReadRoute` | `finance:summary` | `finance:in:summary` |
| `/finance/discover` | `marketReadRoute` | `finance:discover` | `finance:in:discover` |
| `/finance/crypto` | `readRoute` | `finance:crypto` | — (global) |
| `/finance/predictions` | `readRoute` | `finance:predictions` | — (global) |
| `/finance/research` | `readRoute` | `finance:research` | — (global) |

> **`/finance/home` is US-only.** The aggregate landing payload calls the bare `fetchIndices`/
> `fetchStocks` (default `"us"`) against the `finance:indices`/`finance:stocks` keys — it has no
> `?market` plumbing. India consumes the individual market-aware routes, not `/home`. If you make the
> home view market-aware, thread `market` into the `getOrRefresh` keys there too.

TTLs are identical across markets (per-series, set once in `TTL` in routes.ts): indices/stocks/
sectors 300s, summary 900s, discover 600s. India inherits them by reusing the same constants.

---

## 7. The cron warmer's `in:*` jobs

The cron warmer (`POST /finance/cron/refresh`, guarded by `CRON_SECRET`) pre-refreshes both markets
so the first user after a TTL lapse never pays the cold-fetch cost. The India jobs are explicit
entries that call the fetcher with `("in")` and write to `finance:in:*` keys — matching
`marketReadRoute`'s namespace exactly:

```ts
const jobs: [string, () => Promise<unknown>][] = [
  ["indices", fetchIndices], ["stocks", fetchStocks], ["sectors", fetchSectors],
  ["crypto", fetchCrypto], ["predictions", fetchPredictions],
  ["summary", () => fetchMarketSummary("us")],
  // India market (separate finance:in:* keys, matching marketReadRoute):
  ["in:indices",  () => fetchIndices("in")],
  ["in:stocks",   () => fetchStocks("in")],
  ["in:sectors",  () => fetchSectors("in")],
  ["in:summary",  () => fetchMarketSummary("in")],
];
// each refreshed via getOrRefresh(`finance:${key}`, 0, fn)
```

Note the warmer keys are `finance:${key}` where `key` already contains the `in:` prefix
(`finance:in:indices`) — that's why the jobs are named `"in:indices"`, not `"indices"` with a
separate market arg. **India discover is intentionally NOT warmed** (it's on-demand to conserve
Tavily credits); India summary IS warmed because the cold LLM+Tavily generation is the expensive one.
See the warmer in [`routes.ts`](../../../../backend/finance/routes.ts) (`/cron/refresh`).

> When you add a market-aware series, add BOTH its `marketReadRoute` and its `in:`-style warmer job,
> or that market's first post-TTL read pays the full cold cost.

---

## 8. The India geo-block reality (predictions: Polymarket → Manifold)

Predictions are global, but the primary provider **Polymarket is geo-blocked in India** — and not
cleanly: the DNS resolves and the **TCP connect HANGS** rather than refusing, so a naive fetch would
stall the whole panel. The defense (in `sources.ts`) is a fast `PREDICTION_TIMEOUT_MS = 4500` abort
on the Polymarket call, then a fall back to **Manifold** (play-money, open API, reachable from India).
One source per response; `provenance.unit` flips `"USD"` → `"mana"` so the UI labels volume honestly.

This matters for **any** market you add from a region with a different block map: confirm reachability
from the deploy region **and** from where dev/users sit, and give every region-sensitive provider a
fast-timeout fallback. A hanging upstream is worse than a refused one — always bound it with a timeout.
(Full prediction-market detail is in `crypto-and-prediction-markets.md`.)

---

## 9. Anti-patterns

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Putting India stocks through Twelve Data. | TD free excludes NSE/BSE — route India equities through keyless Yahoo (`.NS`/`.BO`). |
| Sharing one cache key for both markets. | Namespace it: `finance:<name>` (US) vs `finance:in:<name>` (India) via `marketReadRoute`. |
| Stripping `.NS`/`.BO` before the Yahoo fetch. | Fetch WITH the suffix; strip only for display on the way out. |
| Rendering India sectors with a `$`/`usd()`. | India sectors are index POINTS → `num()`. Only US SPDR ETFs are `$`. |
| Inferring an Indian index from its ticker. | `^NSMIDCP` is NEXT 50, not midcap — verify each symbol returns data from Yahoo. |
| Flipping `commercialOk:true` for India because it "works". | India is delayed/unofficial, same Tier-1 posture as US — stays `false` (see §10). |
| Adding a market-aware route but forgetting the cron warmer job. | Add BOTH the `marketReadRoute` and the `in:`-style warmer entry. |
| Letting a geo-blocked provider hang the panel. | Fast `AbortController` timeout + regional fallback (Polymarket→Manifold pattern). |
| Treating crypto/predictions as market-aware. | They're global by design — keep them on `readRoute`, USD/mana. |

---

## 10. Licensing posture (hard gate, identical to US)

India inherits the US posture exactly: **every series is `commercialOk:false`** (Yahoo is
unofficial/free; the data is delayed). Real-time NSE/BSE public display requires a paid
six-figure-₹/yr exchange license, and NSE/DotEx are litigious about redistribution — even 15-min
delayed third-party feeds need written consent. So India stays delayed/unofficial Tier-1, demo-only,
never cleared for public launch. If you add the India heatmap, it MUST ride the TradingView embed so
the NSE display license is **TradingView's** burden, not ours. Attribution strings already say
"(delayed)" for every India payload. See `data-licensing-and-compliance.md`.

---

## 11. Checklist: add a NEW market (e.g. EU)

Use this exact order. Most of it is data, not code.

1. **Pick the symbols + provider.** Find the index/watchlist/sector symbols Yahoo resolves (e.g.
   `^STOXX50E`, `^GDAXI`, `SAP.DE`, `ASML.AS`). Confirm Yahoo returns them with a `User-Agent`
   header. If a provider's free tier excludes the exchange (as TD does NSE/BSE), default to Yahoo.
2. **Extend the `Market` type:** `export type Market = "us" | "in" | "eu";` in
   [`sources.ts`](../../../../backend/finance/sources.ts). Add `"EUR"` to `QuotesPayload.currency`.
3. **Add the symbol maps:** `EU_INDICES`, `EU_WATCHLIST`, `EU_SECTORS` (sectors = points if they're
   indices, ETF $ if tradeable). Add any suffix-strip the exchange needs (e.g. `.DE`/`.AS`/`.PA`).
4. **Branch the fetchers:** make `fetchIndices`/`fetchStocks`/`fetchSectors` pick the new list when
   `market === "eu"` (extend the existing `market === "in" ? … : …` ternary into a switch/map). Keep
   US the default.
5. **Currency + render type:** set `currency: "EUR"`; decide points-vs-`$` per surface and wire the
   frontend formatter (extend `money()` locale map; `num()` for index-point sectors).
6. **Cache keys are automatic** — `marketReadRoute` already builds `finance:<market>:<name>` for any
   non-US market. Just verify the key prefix is what you expect; the US-default fallback covers
   unknown `?market` values.
7. **Add cron warmer jobs:** one `["eu:indices", () => fetchIndices("eu")]` entry per market-aware
   series you want hot (skip discover if it's on-demand). Match the key prefix to `marketReadRoute`.
8. **Geo/reachability check:** confirm every provider is reachable from the deploy region AND the new
   market's region; add a fast-timeout fallback for anything region-blocked (the §8 pattern).
9. **Summary/discover (LLM/Tavily):** branch the prompt + Tavily query/`includeDomains` to the new
   region (the India summary swaps to NIFTY/Sensex/RBI/rupee; EU → STOXX/DAX/ECB/euro). Add the
   warmer job for summary; leave discover on-demand.
10. **Frontend:** add the market to the switcher dropdown + `MarketContext`, thread `market` into
    every TanStack Query key (`["finance","indices",market]`), and add the locale formatter + an
    "as-of"/market-hours line in the local timezone.
11. **Licensing verdict:** write the one-sentence display verdict (default `commercialOk:false`,
    delayed/unofficial) and ensure any heatmap rides a third-party embed so the exchange license
    isn't ours.
12. **Verify live:** hit `/finance/indices?market=eu` (and stocks/sectors/summary) → 200 with real
    values; cross-check a few numbers against a reference source the way India's were verified. New
    backend files/symbols → **full dev-server restart** (Bun `--hot` won't pick up new files).

---

## 12. Quick reference — where everything lives

| Concern | File / symbol |
|---------|---------------|
| `Market` type, all symbol maps, fetchers | [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) |
| `INDIA_INDICES` / `INDIA_WATCHLIST` / `INDIA_SECTORS` | `sources.ts` |
| Suffix strip, INR currency | `fetchStocks("in")` in `sources.ts` |
| Shared Yahoo fetch (US + India) | `fetchYahooQuote` in `sources.ts` |
| `?market=in` → `finance:in:*` keys | `marketReadRoute` in [`backend/finance/routes.ts`](../../../../backend/finance/routes.ts) |
| US-only aggregate | `/finance/home` in `routes.ts` |
| India cron warming | `in:*` jobs in `/cron/refresh` in `routes.ts` |
| India summary prompt swap | `fetchMarketSummary("in")` (`summary.ts`) — see `llm-market-narratives.md` |
| India discover (Tavily) | `fetchDiscover("in")` (`news.ts`) |
