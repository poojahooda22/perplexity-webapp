// ─────────────────────────────────────────────────────────────────────────
// Free-tier finance data sources. Each fetcher returns clean, frontend-ready data
// plus provenance (source + attribution + a commercialOk gate).
//
//   • CoinGecko  — crypto. The free Demo endpoint works for dev; Demo is PERSONAL-USE
//                  only, so commercialOk=false. Buy CoinGecko Basic (~$35/mo) and set
//                  COINGECKO_API_KEY to display publicly; then flip commercialOk=true.
//   • Polymarket — prediction markets. Public Gamma API, no key. Confirm commercial-
//                  display terms before a public launch (commercialOk stays false until).
//
// The commercialOk flag is the hard licensing gate: a `false` series is fine to build
// and demo with, but must be treated as not-cleared-for-public-display.
// ─────────────────────────────────────────────────────────────────────────

export type Provenance = {
  source: string;
  commercialOk: boolean;
  attribution: string;
  unit?: "USD" | "mana"; // prediction-market volume unit (Polymarket=USD, Manifold=mana)
};

/* ── Crypto (CoinGecko) ───────────────────────────────────────────────── */

export type CryptoCoin = {
  id: string;
  symbol: string;
  name: string;
  image: string;
  price: number;
  change24h: number | null;
  marketCap: number | null;
  sparkline: number[];
};
export type CryptoPayload = { coins: CryptoCoin[]; provenance: Provenance };

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

function coingeckoHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { "x-cg-demo-api-key": key } : {};
}

function mapCoinGeckoRow(c: Record<string, any>): CryptoCoin {
  return {
    id: String(c.id),
    symbol: String(c.symbol ?? "").toUpperCase(),
    name: String(c.name ?? ""),
    image: String(c.image ?? ""),
    price: Number(c.current_price ?? 0),
    change24h: c.price_change_percentage_24h != null ? Number(c.price_change_percentage_24h) : null,
    marketCap: c.market_cap != null ? Number(c.market_cap) : null,
    sparkline: Array.isArray(c.sparkline_in_7d?.price) ? c.sparkline_in_7d.price.map(Number) : [],
  };
}

function cgProvenance(): Provenance {
  return {
    source: "CoinGecko",
    commercialOk: false, // Demo tier = personal use; flip true on a paid commercial plan.
    attribution: "Data provided by CoinGecko",
  };
}

export async function fetchCrypto(): Promise<CryptoPayload> {
  const url =
    `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
    `&per_page=12&page=1&sparkline=true&price_change_percentage=24h`;
  const res = await fetch(url, { headers: coingeckoHeaders() });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, any>>;
  return { coins: rows.map(mapCoinGeckoRow), provenance: cgProvenance() };
}

// Parameterized crypto fetch (agent-tool backend) — prices/market data for a SPECIFIC set
// of CoinGecko coin ids (e.g. ["bitcoin","ethereum"]) so the chat agent can answer
// "BTC vs ETH". Demo tier limits still apply, so callers go through getOrRefresh + the
// rate limiter. Threads an AbortSignal (client disconnect) combined with a hard timeout.
export async function fetchCryptoMarkets(
  ids: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<CryptoPayload> {
  const list = [...new Set(ids.map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  if (list.length === 0) return { coins: [], provenance: cgProvenance() };

  const timeout = AbortSignal.timeout(8000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const url =
    `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(list.join(","))}` +
    `&order=market_cap_desc&per_page=${list.length}&page=1&sparkline=false&price_change_percentage=24h`;
  const res = await fetch(url, { headers: coingeckoHeaders(), signal });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, any>>;
  return { coins: rows.map(mapCoinGeckoRow), provenance: cgProvenance() };
}

/* ── Prediction markets (Polymarket) ──────────────────────────────────── */

export type PredictionOutcome = { label: string; probability: number };
export type PredictionMarket = {
  id: string;
  question: string;
  url: string | null;
  image: string | null;
  volume: number | null;
  endDate: string | null;
  outcomes: PredictionOutcome[];
};
export type PredictionsPayload = { markets: PredictionMarket[]; provenance: Provenance };

const POLYMARKET_GAMMA = "https://gamma-api.polymarket.com";
const MANIFOLD_API = "https://api.manifold.markets/v0";

// First-stage fetch timeout. Polymarket is geo-blocked in some regions (e.g. India) where the
// TCP connect HANGS rather than refuses — so we abort fast and fall back to Manifold.
const PREDICTION_TIMEOUT_MS = 4500;

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Gamma returns `outcomes` / `outcomePrices` as JSON-encoded strings (e.g. "[\"Yes\",\"No\"]").
function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Polymarket — real-money markets (what Perplexity uses). Geo-blocked in India.
async function fetchPolymarket(): Promise<PredictionMarket[]> {
  const url =
    `${POLYMARKET_GAMMA}/markets?limit=12&active=true&closed=false` +
    `&order=volume24hr&ascending=false`;
  const res = await fetchWithTimeout(url, PREDICTION_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Polymarket ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, any>>;
  return rows.map((m) => {
    const labels = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices).map(Number);
    return {
      id: String(m.id ?? m.conditionId ?? m.slug ?? ""),
      question: String(m.question ?? m.groupItemTitle ?? "Untitled market"),
      url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
      image: m.image ?? m.icon ?? null,
      volume:
        typeof m.volumeNum === "number" ? m.volumeNum : m.volume != null ? Number(m.volume) : null,
      endDate: m.endDate ?? null,
      outcomes: labels.map((label, i) => ({
        label,
        probability: Number.isFinite(prices[i]) ? prices[i]! : 0,
      })),
    };
  });
}

// Manifold — play-money community markets, open API, reachable from India. The fallback.
async function fetchManifold(): Promise<PredictionMarket[]> {
  const url = `${MANIFOLD_API}/search-markets?term=&sort=score&filter=open&contractType=BINARY&limit=12`;
  const res = await fetchWithTimeout(url, PREDICTION_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Manifold ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, any>>;
  return rows.map((m) => {
    const prob = typeof m.probability === "number" ? m.probability : null;
    return {
      id: String(m.id ?? ""),
      question: String(m.question ?? "Untitled market"),
      url: m.url ?? null,
      image: m.coverImageUrl ?? null,
      volume:
        typeof m.volume24Hours === "number"
          ? m.volume24Hours
          : typeof m.volume === "number"
            ? m.volume
            : null,
      endDate: m.closeTime ? new Date(m.closeTime).toISOString() : null,
      outcomes:
        prob != null
          ? [
              { label: "Yes", probability: prob },
              { label: "No", probability: 1 - prob },
            ]
          : [],
    };
  });
}

// Try Polymarket (authentic real-money markets); fall back to Manifold when it's unreachable
// (geo-block / outage) so the panel still populates. One source per response.
export async function fetchPredictions(): Promise<PredictionsPayload> {
  try {
    const markets = await fetchPolymarket();
    if (markets.length === 0) throw new Error("Polymarket returned no markets");
    return {
      markets,
      provenance: {
        source: "Polymarket",
        commercialOk: false, // confirm commercial-display ToS before flipping true
        attribution: "Prediction market data from Polymarket",
        unit: "USD",
      },
    };
  } catch (e) {
    console.warn("[finance] Polymarket unavailable, using Manifold:", e instanceof Error ? e.message : e);
    const markets = await fetchManifold();
    return {
      markets,
      provenance: {
        source: "Manifold Markets",
        commercialOk: false,
        attribution: "Prediction market data from Manifold Markets",
        unit: "mana",
      },
    };
  }
}

/* ── Watchlist stocks (Twelve Data) + indices (Yahoo) ──────────────────────
 * Twelve Data free tier = stocks/ETFs only (raw indices like ^GSPC need a paid plan) and
 * 8 API credits/min (1 credit PER SYMBOL — batching doesn't save credits). So we split:
 *   • company-stock WATCHLIST → Twelve Data batched quote (key in TWELVE_DATA_API_KEY).
 *   • index TOP ASSETS        → Yahoo's public chart API (no key, no credit limit, REAL
 *                               index values + sparkline; reachable from India).
 * Both are free/personal tiers → commercialOk:false until a paid display tier.
 * ──────────────────────────────────────────────────────────────────────── */

export type Quote = {
  symbol: string;
  name: string;
  price: number;
  change: number | null;
  changePercent: number | null;
  sparkline?: number[];
};
export type Market = "us" | "in";
export type QuotesPayload = {
  items: Quote[];
  provenance: Provenance;
  needsKey?: boolean;
  currency?: "USD" | "INR";
};

// ── Top Assets via Yahoo (real index values + sparkline, no key, no credit limit) ──
const YAHOO_INDICES: { symbol: string; name: string }[] = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^IXIC", name: "NASDAQ" },
  { symbol: "^DJI", name: "Dow Jones" },
  { symbol: "^VIX", name: "VIX" },
];

// India indices (Yahoo, keyless, INR/IST) — values live-verified to match Perplexity's India tab.
const INDIA_INDICES: { symbol: string; name: string }[] = [
  { symbol: "^NSEI", name: "NIFTY 50" },
  { symbol: "^BSESN", name: "S&P BSE Sensex" },
  { symbol: "^NSEBANK", name: "Nifty Bank" },
  { symbol: "^CNXIT", name: "Nifty IT" },
];

// India watchlist via Yahoo (.NS = NSE, .BO = BSE). Twelve Data's FREE tier EXCLUDES NSE/BSE, so
// India stocks ride the same keyless Yahoo path as the indices — no key, returns INR natively.
const INDIA_WATCHLIST: { symbol: string; name: string }[] = [
  { symbol: "RELIANCE.BO", name: "Reliance Industries" },
  { symbol: "TATATECH.NS", name: "Tata Technologies" },
  { symbol: "ICICIGI.NS", name: "ICICI Lombard" },
  { symbol: "INFY.NS", name: "Infosys" },
  { symbol: "TCS.NS", name: "TCS" },
  { symbol: "HDFCBANK.NS", name: "HDFC Bank" },
];

async function fetchYahooQuote(symbol: string, fallbackName: string): Promise<Quote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
    const res = await fetchWithTimeout(url, 8000, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") return null;
    const price = meta.regularMarketPrice as number;
    const closes: number[] = (result?.indicators?.quote?.[0]?.close ?? []).filter(
      (n: unknown): n is number => typeof n === "number",
    );
    // DAILY change: the previous close is YESTERDAY's. With interval=1d the last close is
    // today's, so yesterday is the second-to-last close. (meta.chartPreviousClose is the close
    // before the ENTIRE range — ~1mo ago — which would give the monthly move, not the daily.)
    const prev =
      closes.length >= 2
        ? closes[closes.length - 2]!
        : typeof meta.chartPreviousClose === "number"
          ? meta.chartPreviousClose
          : null;
    return {
      symbol,
      name: fallbackName, // our curated short label ("S&P 500", "NASDAQ", "Dow Jones", "VIX")
      price,
      change: prev != null ? price - prev : null,
      changePercent: prev ? ((price - prev) / prev) * 100 : null,
      sparkline: closes,
    };
  } catch {
    return null;
  }
}

export async function fetchIndices(market: Market = "us"): Promise<QuotesPayload> {
  const list = market === "in" ? INDIA_INDICES : YAHOO_INDICES;
  const items = await Promise.all(list.map((i) => fetchYahooQuote(i.symbol, i.name)));
  return {
    items: items.filter((q): q is Quote => q !== null),
    provenance: {
      source: "Yahoo Finance",
      commercialOk: false,
      attribution:
        market === "in" ? "India index data via Yahoo Finance (delayed)" : "Index data via Yahoo Finance",
    },
    currency: market === "in" ? "INR" : "USD",
  };
}

// ── Equity sectors via the SPDR Select Sector ETFs (Yahoo, same path as indices) ──
// Perplexity's "Equity Sectors" card is the 11 GICS sectors shown as their tradeable
// SPDR ETF PROXIES (price + daily % change). We reuse the same keyless Yahoo chart API
// as the indices — 11 symbols, no credit limit, real values. ETF proxy → commercialOk:false.
const SECTOR_ETFS: { symbol: string; name: string }[] = [
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLE", name: "Energy" },
  { symbol: "XLY", name: "Consumer Cyclical" },
  { symbol: "XLP", name: "Consumer Defensive" },
  { symbol: "XLC", name: "Communication Services" },
  { symbol: "XLI", name: "Industrials" },
  { symbol: "XLF", name: "Financial Services" },
  { symbol: "XLU", name: "Utilities" },
  { symbol: "XLB", name: "Basic Materials" },
  { symbol: "XLRE", name: "Real Estate" },
  { symbol: "XLV", name: "Healthcare" },
];

// India "Equity Sectors" = the NSE sectoral INDICES (Yahoo, keyless). Unlike the US SPDR ETFs
// (tradeable $ prices), these are index POINTS — the frontend formats them with num(), not a
// currency symbol. All symbols live-verified to return data via the Yahoo chart API.
const INDIA_SECTORS: { symbol: string; name: string }[] = [
  { symbol: "^CNXIT", name: "Nifty IT" },
  { symbol: "^NSEBANK", name: "Nifty Bank" },
  { symbol: "^CNXAUTO", name: "Nifty Auto" },
  { symbol: "^CNXFMCG", name: "Nifty FMCG" },
  { symbol: "^CNXPHARMA", name: "Nifty Pharma" },
  { symbol: "^CNXMETAL", name: "Nifty Metal" },
  { symbol: "^CNXENERGY", name: "Nifty Energy" },
  { symbol: "^CNXFIN", name: "Nifty Fin Services" },
  { symbol: "^CNXREALTY", name: "Nifty Realty" },
  { symbol: "^CNXMEDIA", name: "Nifty Media" },
  { symbol: "^CNXINFRA", name: "Nifty Infra" },
];

export async function fetchSectors(market: Market = "us"): Promise<QuotesPayload> {
  const list = market === "in" ? INDIA_SECTORS : SECTOR_ETFS;
  const items = await Promise.all(list.map((s) => fetchYahooQuote(s.symbol, s.name)));
  return {
    items: items.filter((q): q is Quote => q !== null),
    provenance: {
      source: "Yahoo Finance",
      commercialOk: false,
      attribution:
        market === "in" ? "India sector indices via Yahoo Finance (delayed)" : "Sector ETF data via Yahoo Finance",
    },
    currency: market === "in" ? "INR" : "USD",
  };
}

// ── Watchlist via Twelve Data (free tier: stocks/ETFs, 8 credits/min = 8 symbols/min) ──
const TWELVE_BASE = "https://api.twelvedata.com";
const TWELVE_TIMEOUT_MS = 8000;

// Keep the count small — each symbol is 1 credit and the free cap is 8/min.
const DEFAULT_WATCHLIST = ["GOOGL", "NVDA", "TSLA", "META", "AAPL", "AMZN"];

function twelveKey(): string | null {
  const k = process.env.TWELVE_DATA_API_KEY;
  return k && k !== "demo" ? k : null; // "demo" only works for a couple symbols → treat as no key
}

function tdProvenance(): Provenance {
  return { source: "Twelve Data", commercialOk: false, attribution: "Stock quotes by Twelve Data" };
}

function parseTdQuote(symbol: string, name: string, q: any): Quote | null {
  if (!q || q.status === "error" || q.code) return null;
  const price = Number(q.close ?? q.price);
  if (!Number.isFinite(price)) return null;
  return {
    symbol,
    name: name || q.name || symbol,
    price,
    change: q.change != null ? Number(q.change) : null,
    changePercent: q.percent_change != null ? Number(q.percent_change) : null,
  };
}

export async function fetchStocks(market: Market = "us"): Promise<QuotesPayload> {
  // India: Twelve Data's free tier excludes NSE/BSE, so the India watchlist uses the keyless Yahoo
  // path (returns INR). Strip the .NS/.BO suffix for display (TATATECH.NS → TATATECH).
  if (market === "in") {
    const items = (await Promise.all(INDIA_WATCHLIST.map((s) => fetchYahooQuote(s.symbol, s.name))))
      .filter((q): q is Quote => q !== null)
      .map((q) => ({ ...q, symbol: q.symbol.replace(/\.(NS|BO)$/i, "") }));
    return {
      items,
      provenance: {
        source: "Yahoo Finance",
        commercialOk: false,
        attribution: "India stock data via Yahoo Finance (delayed)",
      },
      currency: "INR",
    };
  }
  const key = twelveKey();
  if (!key) return { items: [], provenance: tdProvenance(), needsKey: true, currency: "USD" };
  const url = `${TWELVE_BASE}/quote?symbol=${encodeURIComponent(DEFAULT_WATCHLIST.join(","))}&apikey=${key}`;
  const res = await fetchWithTimeout(url, TWELVE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`TwelveData ${res.status}`);
  const data = (await res.json()) as Record<string, any>;
  // A single symbol returns the quote directly; many return an object keyed by symbol.
  // A whole-response error object (e.g. 429 credit limit) must surface as a failure.
  if (data && (data.status === "error" || data.code)) {
    throw new Error(`TwelveData: ${data.message ?? "error"}`);
  }
  const quotes = DEFAULT_WATCHLIST.length === 1 ? { [DEFAULT_WATCHLIST[0]!]: data } : data;
  const items = DEFAULT_WATCHLIST.map((sym) => parseTdQuote(sym, "", quotes[sym])).filter(
    (q): q is Quote => q !== null,
  );
  return { items, provenance: tdProvenance(), currency: "USD" };
}

// ── Parameterized quote fetch (agent-tool backend) ─────────────────────────
// Same Twelve Data /quote call as fetchStocks(), but for an ARBITRARY symbol set so the
// finance chat agent can answer "price of MSFT". 1 credit PER symbol and the free cap is
// 8 credits/min, so callers MUST go through getOrRefresh (cache + in-flight de-dupe) and
// the finance rate limiter. We hard-cap at 8 symbols/call as a backstop and thread an
// optional AbortSignal so a client disconnect cancels the in-flight vendor call (and stops
// burning the credit budget). Combined with a hard timeout via AbortSignal.any.
export async function fetchQuotes(
  symbols: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<QuotesPayload> {
  const list = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 8);
  if (list.length === 0) return { items: [], provenance: tdProvenance() };
  const key = twelveKey();
  if (!key) return { items: [], provenance: tdProvenance(), needsKey: true };

  const timeout = AbortSignal.timeout(TWELVE_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const url = `${TWELVE_BASE}/quote?symbol=${encodeURIComponent(list.join(","))}&apikey=${key}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`TwelveData ${res.status}`);
  const data = (await res.json()) as Record<string, any>;
  if (data && (data.status === "error" || data.code)) {
    // 429 = credit/rate limit → a REAL failure; surface it so getOrRefresh can serve stale.
    if (Number(data.code) === 429) throw new Error(`TwelveData: ${data.message ?? "rate limited"}`);
    // Otherwise a single-symbol top-level error is just an unknown/bad ticker (TD returns the
    // quote directly for 1 symbol). Degrade gracefully to empty instead of throwing the whole
    // tool turn — consistent with the multi-symbol path, which drops bad symbols via parseTdQuote.
    if (list.length === 1) return { items: [], provenance: tdProvenance() };
    throw new Error(`TwelveData: ${data.message ?? "error"}`);
  }
  const quotes = list.length === 1 ? { [list[0]!]: data } : data;
  const items = list
    .map((sym) => parseTdQuote(sym, "", quotes[sym]))
    .filter((q): q is Quote => q !== null);
  return { items, provenance: tdProvenance() };
}
