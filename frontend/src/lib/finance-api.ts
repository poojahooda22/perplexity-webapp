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
  volume24h?: number | null;
  rank?: number | null;
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
// All-Exchanges leaderboard (reuses CryptoPayload; rows now carry volume24h + rank).
export const fetchCryptoLeaderboard = () => getJson<CryptoPayload>("/finance/crypto/leaderboard");

// Lumina Crypto 50 — our own cap-weighted index (NOT the licensed Coinbase 50).
export type CryptoIndexRange = "1d" | "5d" | "1m" | "3m" | "6m" | "1y";
export interface IndexPoint {
  t: number;
  v: number;
}
export interface CryptoIndexPayload {
  name: string;
  range: CryptoIndexRange;
  base: number;
  value: number;
  changeAbs: number;
  changePct: number | null;
  series: IndexPoint[];
  standouts: CryptoCoin[];
  provenance: Provenance;
  fetchedAt?: number;
  stale?: boolean;
}
export const fetchCryptoIndex = (range: CryptoIndexRange = "6m") =>
  getJson<CryptoIndexPayload>(`/finance/crypto/index?range=${range}`);
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

/* ── Market Insights ("Pulse") — GREEN public-domain surfaces ──────────── */

export interface RecessionPayload {
  probability: number;
  probabilityPct: number;
  spread10y3m: number;
  spread10y2y: number;
  yields: { m3: number; y2: number; y10: number };
  curveInverted: boolean;
  sahm: { value: number; triggered: boolean; latestUnemployment: number; asOf: string } | null;
  asOf: string;
  methodology: string;
  caveat: string;
  provenance: Provenance;
  fetchedAt?: number;
  stale?: boolean;
}
export const fetchRecession = () => getJson<RecessionPayload>("/finance/recession");

export interface SentimentPoint {
  t: number;
  v: number;
}
export interface SentimentPayload {
  market: Market;
  score: number; // -100..+100
  label: string;
  toneLatest: number;
  toneSeries: SentimentPoint[];
  buzz: number; // 0..100
  buzzSeries: SentimentPoint[];
  caveat: string;
  provenance: Provenance;
  fetchedAt?: number;
  stale?: boolean;
}
export const fetchGdelt = (market: Market = "us") =>
  getJson<SentimentPayload>(`/finance/gdelt${marketQuery(market)}`);

export interface MoodComponent {
  name: string;
  score: number; // 0..100
  note: string;
}
export interface MoodPayload {
  market: Market;
  score: number; // 0..100
  label: string;
  components: MoodComponent[];
  asOf: string;
  caveat: string;
  provenance: Provenance;
  fetchedAt?: number;
  stale?: boolean;
}
export const fetchMood = (market: Market = "us") =>
  getJson<MoodPayload>(`/finance/mood${marketQuery(market)}`);

export interface BriefingLevel {
  asset: string;
  level: number;
  change: number | null;
  changePct: number | null;
}
export interface BriefingSource {
  n: number;
  title: string;
  url: string;
}
export interface BriefingPayload {
  market: Market;
  columnist: string;
  generatedAt: string;
  marketTake: { mood: string; headline: string; body: string };
  bottomLine: string;
  whatMoved: { driver: string; why: string }[];
  sentimentRead: string;
  catalysts: { event: string; note: string }[];
  onInvestorsMinds: { question: string; take: string }[];
  followUps: string[];
  levels: BriefingLevel[];
  mood: { score: number; label: string } | null;
  recession: { probabilityPct: number; spread10y3m: number } | null;
  sentiment: { label: string; score: number } | null;
  sources: BriefingSource[];
  provenance: Provenance;
  fetchedAt?: number;
  stale?: boolean;
}
export const fetchBriefing = (market: Market = "us") =>
  getJson<BriefingPayload>(`/finance/briefing${marketQuery(market)}`);

export interface ScorecardCall {
  id: string;
  claim: string;
  direction: string;
  status: string;
  correct: boolean | null;
  madeAt: string;
  resolveAt: string;
  resolvedAt: string | null;
  notes: string | null;
}
export interface ScorecardPayload {
  signalKey: string;
  summary: { total: number; resolved: number; correct: number; hitRate: number | null; open: number };
  calls: ScorecardCall[];
  moodHistory: { date: string; score: number; label: string }[];
  fetchedAt?: number;
  stale?: boolean;
}
export const fetchScorecard = () => getJson<ScorecardPayload>("/finance/scorecard");
