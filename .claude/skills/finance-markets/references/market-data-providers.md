# Market Data Providers — capabilities, limits, and selection

> The free-tier provider landscape Lumina actually uses, with the **exact** limits and error
> shapes that decide the architecture. Knowing the limit is the design — "8 credits/min, 1 per
> symbol" is *why* the watchlist is 6 symbols on a 300s TTL. Pair this with
> `data-licensing-and-compliance.md` (can you *display* it) and `caching-and-rate-budgets.md`
> (how to stay under the cap).

---

## Selection matrix (start here)

| Need | Use | Why | Avoid |
|------|-----|-----|-------|
| US stock/ETF quote | **Twelve Data** `/quote` | Real OHLC + % change; free key | Yahoo for the watchlist (unofficial, no batch contract) |
| Index VALUE (S&P/NASDAQ/VIX/NIFTY) | **Yahoo** `v8/finance/chart` | Real index level + sparkline, no key, no cap, reachable from India | Twelve Data free (404s on raw indices — "Grow plan") |
| India stock/index/sector | **Yahoo** (`.NS`/`.BO`, `^NSEI`…) | TD free excludes NSE/BSE; Yahoo returns INR natively | Twelve Data free; real-time NSE/BSE (licensed, 6-figure ₹) |
| Crypto price/mcap/24h | **CoinGecko** `coins/markets` | Broad coin coverage, ids, sparkline | Binance/exchange APIs for "prices" (per-pair, no mcap) |
| Crypto/forex REAL-TIME ticks | **Finnhub WebSocket** (in `worker/`) | Free WS streams `BINANCE:*`/`OANDA:*` real-time | Polling REST for "live" (burns quota, not live) |
| Prediction markets | **Polymarket** → **Manifold** fallback | Polymarket = real-money (what Perplexity shows); Manifold = reachable from India | Polymarket-only (geo-blocked in India) |
| Finance news | **Finnhub `/news`** (US) / **Tavily** (IN + agent) | Finnhub free news; Tavily for synthesis + India publishers | Republishing full article text (licensing) |
| Macro/fundamentals (future) | Treasury/BLS/BEA/World Bank/SEC EDGAR (public domain) | Displayable by license | FRED for *display* (discovery-only; don't redistribute S&P/ICE via it) |
| Commercial US-equity display (Tier-2) | **FMP** commercial Data Display license | Perplexity's spine; sales-quoted | FMP self-serve tiers for public display (ToS forbids) |

---

## Twelve Data — US stocks/ETFs (the budget-defining provider)

- **Base:** `https://api.twelvedata.com`; key in `TWELVE_DATA_API_KEY` (`"demo"` ⇒ treat as no key —
  works for only a couple symbols). `twelveKey()` in `sources.ts` enforces this.
- **THE limit:** free tier = **8 API credits/minute** and **1 credit PER SYMBOL** — batching the
  `/quote?symbol=A,B,C` call does **NOT** save credits. Also ~800 calls/day.
- **Design consequence:** `DEFAULT_WATCHLIST` = 6 symbols (GOOGL/NVDA/TSLA/META/AAPL/AMZN) = 6
  credits/refresh, TTL 300s ⇒ ≈ within budget. The agent's `getQuote` budget is 6/min and hard-caps
  at 8 symbols/call.
- **No free sparkline:** `time_series` is 1 credit each → blows the budget. Watchlist ships without
  sparklines (or use Yahoo's close array).
- **Free tier excludes:** raw indices (`SPX`/`^GSPC` → 404 "available on Grow plan") and NSE/BSE.
- **Error shapes (handle all):** a single-symbol request returns the quote object directly; many
  return an object keyed by symbol. A whole-response error is `{status:"error"|code, message}`.
  `parseTdQuote` returns `null` on `status:"error"`/`code`/non-finite price (drops bad rows). A
  `code===429` (credit/rate limit) **must throw** so `getOrRefresh` serves stale; a single-symbol
  non-429 error degrades to empty (likely a bad ticker).
- Provenance: `{source:"Twelve Data", commercialOk:false}` until a paid display tier.

## Yahoo chart API — indices, India, sparklines (the keyless workhorse)

- **Endpoint:** `https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?interval=1d&range=1mo`.
  **Requires a `User-Agent` header** (`Mozilla/5.0`) or it 4xxs. No key, no documented rate limit
  (don't hammer it), reachable from India.
- **Shape:** `chart.result[0].meta.regularMarketPrice` = current; `indicators.quote[0].close` =
  close array (the sparkline). **Daily change pitfall:** previous close = `closes[len-2]` (yesterday),
  NOT `meta.chartPreviousClose` (close before the whole 1-month range ⇒ would show the monthly move).
- **Symbols used:** US indices `^GSPC ^IXIC ^DJI ^VIX`; India `^NSEI ^BSESN ^NSEBANK ^CNXIT`;
  India stocks `RELIANCE.BO TATATECH.NS …` (.NS = NSE, .BO = BSE — strip the suffix for display);
  India sectors `^CNXIT ^NSEBANK ^CNXAUTO …` (index points, not ETF $).
- **Status:** unofficial/free → `commercialOk:false`. Robust but undocumented; wrap in
  `fetchWithTimeout` (8s) and return `null` per-symbol on any failure (`fetchIndices`/`fetchSectors`
  filter nulls).

## CoinGecko — crypto

- **Base:** `https://api.coingecko.com/api/v3`; optional Demo key header `x-cg-demo-api-key`
  (`COINGECKO_API_KEY`). `coins/markets?vs_currency=usd&ids=…&sparkline=…&price_change_percentage=24h`.
- **Limits:** Demo ≈ 30 calls/min is CoinGecko's *published* Demo cap (the `tools.ts` comment says
  100/min — treat 30 as the safe number). Either way the agent budget `getCrypto` = 20/min, hard-cap
  15 ids/call, stays under. The
  card fetch uses top-12 by market cap with sparkline; the agent fetch takes explicit ids, no sparkline.
- **Licensing trap:** the free **Demo tier is PERSONAL USE only** ⇒ `commercialOk:false`. CoinGecko
  **Basic (~$35/mo)** is required to display publicly; only then flip `commercialOk:true`.
- **Coin ids, not tickers:** `bitcoin`/`ethereum`/`solana` (lowercase). Map user tickers → ids.

## Finnhub — real-time ticks + US news

- **WebSocket** (in `worker/` only — never a Vercel route): free WS streams **crypto** (`BINANCE:*`)
  and **forex** (`OANDA:*`) **real-time**; **stocks** show 0 ticks when the US market is closed
  (real-time-vs-delayed verify at market open via `backend/_finnhub_probe.ts`). One WS, ticks
  coalesced to 1/sec, broadcast to Supabase Realtime.
- **REST `/news`** powers the US Discover carousel.
- **Env quirk:** key accepted as `FINNHUB_API_KEY || FINHUB_API_KEY` (user's key has one N).
  Server-side (worker) only; the browser holds only the Supabase anon key.

## Polymarket → Manifold — prediction markets

- **Polymarket Gamma** `https://gamma-api.polymarket.com/markets?…&order=volume24hr` — real-money
  markets (what Perplexity shows). `outcomes`/`outcomePrices` come back as JSON-encoded **strings**
  → `parseJsonArray`. **Geo-blocked in India** (DNS resolves, TCP hangs) → 4.5s `AbortController`
  timeout, then fall back.
- **Manifold** `https://api.manifold.markets/v0/search-markets` — play-money, open API, reachable
  from India. Binary markets give `probability` → derive Yes/No.
- **Unit honesty:** `provenance.unit` = "USD" (Polymarket) vs "mana" (Manifold) so the UI labels
  volume correctly. One source per response.

## FMP & macro (Tier-2 / future)

- **FMP** = Perplexity's core equities spine, but **self-serve tiers ($0–$99) FORBID public display**
  (ToS 2.2.1/2.2.2). Public US-equity display needs FMP's **separately sales-quoted commercial Data
  Display license** (default to 15-min delayed to bound per-user exchange fees). Defer to Tier-2.
- **Macro for display:** pull from public-domain primaries (US Treasury Fiscal Data, BLS, BEA,
  World Bank, SEC EDGAR, GDELT). FRED is discovery-only — do not redistribute proprietary series
  (S&P/VIX/ICE) through it.

---

## Adding a new provider — the checklist

1. Write a fetcher in `sources.ts` returning clean data + a `Provenance` with the correct
   `commercialOk` (default **false** — see licensing ref).
2. Find the exact free-tier limit (per-minute, per-day, per-symbol) and set the agent-tool budget
   and route TTL under it. Document the math in a comment, like `DEFAULT_WATCHLIST`.
3. Handle every error shape: per-row drop vs whole-response throw; make the rate-limit/429 case
   **throw** so the cache serves stale.
4. Thread a timeout (`fetchWithTimeout`/`AbortSignal.timeout`); for agent tools, combine with the
   client-disconnect signal via `AbortSignal.any` but **never** thread the disconnect signal into a
   shared cached fetcher (one caller's disconnect must not abort others — see `tools.ts` note).
5. Confirm reachability from the deploy region AND from India (dev) — add a fallback if geo-blocked.
6. Decide displayability and write the one-sentence licensing verdict.

> **Cross-repo:** the deepest provider ranking + licensing prior art is fintech-webapp's
> `research-data-sourcing/references/market-data-apis.md` + `licensing-tiers.md`. Translate its
> Next.js examples to our Express/Prisma stack.
