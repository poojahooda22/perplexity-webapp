import { BACKEND_URL } from "./config";

export type Provenance = {
  source: string;
  commercialOk: boolean;
  attribution: string;
  unit?: "USD" | "mana";
};

export interface CryptoCoin {
  id: string;
  symbol: string;
  name: string;
  image: string;
  price: number;
  change24h: number | null;
  marketCap: number | null;
  sparkline: number[];
}
export interface CryptoPayload {
  coins: CryptoCoin[];
  provenance: Provenance;
  fetchedAt?: number;
  stale?: boolean;
}

export interface PredictionOutcome {
  label: string;
  probability: number;
}
export interface PredictionMarket {
  id: string;
  question: string;
  url: string | null;
  image: string | null;
  volume: number | null;
  endDate: string | null;
  outcomes: PredictionOutcome[];
}
export interface PredictionsPayload {
  markets: PredictionMarket[];
  provenance: Provenance;
  fetchedAt?: number;
  stale?: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  change: number | null;
  changePercent: number | null;
  sparkline?: number[];
}
export type Market = "us" | "in";
export interface QuotesPayload {
  items: Quote[];
  provenance: Provenance;
  needsKey?: boolean;
  currency?: "USD" | "INR";
  fetchedAt?: number;
  stale?: boolean;
}

export const fetchCrypto = () => getJson<CryptoPayload>("/finance/crypto");
export const fetchPredictions = () => getJson<PredictionsPayload>("/finance/predictions");
const marketQuery = (market: Market) => (market === "in" ? "?market=in" : "");
export const fetchIndices = (market: Market = "us") =>
  getJson<QuotesPayload>(`/finance/indices${marketQuery(market)}`);
export const fetchStocks = (market: Market = "us") =>
  getJson<QuotesPayload>(`/finance/stocks${marketQuery(market)}`);
// fetchSectors is market-aware: US = SPDR sector ETFs, IN = NSE sectoral indices.
export const fetchSectors = (market: Market = "us") =>
  getJson<QuotesPayload>(`/finance/sectors${marketQuery(market)}`);

export interface SummaryItem {
  headline: string;
  body: string;
}
export interface SummarySource {
  title: string;
  url: string;
  content: string;
}
export interface SummaryPayload {
  items: SummaryItem[];
  sources: SummarySource[];
  updatedAt: string;
  provenance: Provenance;
  stale?: boolean;
}
export const fetchMarketSummary = (market: Market = "us") =>
  getJson<SummaryPayload>(`/finance/summary${marketQuery(market)}`);

export interface ResearchSource {
  title: string;
  url: string;
}
export interface ResearchNote {
  category: string;
  label: string;
  title: string;
  summary: string;
  keyPoints: string[];
  body: string[];
  sources: ResearchSource[];
  updatedAt: string;
}
export interface ResearchPayload {
  notes: ResearchNote[];
  stale?: boolean;
}
export const fetchResearch = () => getJson<ResearchPayload>("/finance/research");

export interface DiscoverArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  image: string | null;
  publishedAt: string;
  category: string;
}
export interface DiscoverPayload {
  articles: DiscoverArticle[];
  provenance: Provenance;
  needsKey?: boolean;
  stale?: boolean;
}
export const fetchDiscover = (market: Market = "us") =>
  getJson<DiscoverPayload>(`/finance/discover${marketQuery(market)}`);
