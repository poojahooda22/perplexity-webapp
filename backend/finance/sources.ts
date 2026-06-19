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

export async function fetchCrypto(): Promise<CryptoPayload> {
  const url =
    `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
    `&per_page=12&page=1&sparkline=true&price_change_percentage=24h`;
  const res = await fetch(url, { headers: coingeckoHeaders() });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, any>>;
  const coins: CryptoCoin[] = rows.map((c) => ({
    id: String(c.id),
    symbol: String(c.symbol ?? "").toUpperCase(),
    name: String(c.name ?? ""),
    image: String(c.image ?? ""),
    price: Number(c.current_price ?? 0),
    change24h: c.price_change_percentage_24h != null ? Number(c.price_change_percentage_24h) : null,
    marketCap: c.market_cap != null ? Number(c.market_cap) : null,
    sparkline: Array.isArray(c.sparkline_in_7d?.price) ? c.sparkline_in_7d.price.map(Number) : [],
  }));
  return {
    coins,
    provenance: {
      source: "CoinGecko",
      commercialOk: false, // Demo tier = personal use; flip true on a paid commercial plan.
      attribution: "Data provided by CoinGecko",
    },
  };
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
export type QuotesPayload = { items: Quote[]; provenance: Provenance; needsKey?: boolean };

// ── Top Assets via Yahoo (real index values + sparkline, no key, no credit limit) ──
const YAHOO_INDICES: { symbol: string; name: string }[] = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^IXIC", name: "NASDAQ" },
  { symbol: "^DJI", name: "Dow Jones" },
  { symbol: "^VIX", name: "VIX" },
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
    const prev = typeof meta.chartPreviousClose === "number" ? meta.chartPreviousClose : null;
    const closes: number[] = (result?.indicators?.quote?.[0]?.close ?? []).filter(
      (n: unknown): n is number => typeof n === "number",
    );
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

export async function fetchIndices(): Promise<QuotesPayload> {
  const items = await Promise.all(YAHOO_INDICES.map((i) => fetchYahooQuote(i.symbol, i.name)));
  return {
    items: items.filter((q): q is Quote => q !== null),
    provenance: {
      source: "Yahoo Finance",
      commercialOk: false,
      attribution: "Index data via Yahoo Finance",
    },
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

export async function fetchStocks(): Promise<QuotesPayload> {
  const key = twelveKey();
  if (!key) return { items: [], provenance: tdProvenance(), needsKey: true };
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
  return { items, provenance: tdProvenance() };
}
