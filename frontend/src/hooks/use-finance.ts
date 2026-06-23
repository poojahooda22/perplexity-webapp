import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  fetchBriefing,
  fetchScorecard,
  fetchCrypto,
  fetchCryptoIndex,
  fetchCryptoLeaderboard,
  fetchDiscover,
  fetchGdelt,
  fetchIndices,
  fetchMarketSummary,
  fetchMood,
  fetchPredictions,
  fetchRecession,
  fetchResearch,
  fetchSectors,
  fetchStocks,
  type Market,
  type CryptoIndexRange,
} from "@/lib/finance-api";

// Each endpoint's cadence is tied to how often the data can actually change (and to the
// backend's cache TTL). We poll at that cadence (refetchInterval) AND treat the data as fresh
// for the same window (staleTime), so leaving the tab and coming back within the window is
// served from the in-memory cache with NO refetch — this is what stops a tab revisit from
// re-running the slow market-summary/predictions calls. gcTime keeps the cached data alive
// across the tab unmount for at least that long (never below React Query's 5-min default).
const MIN = 60_000;
const keepAlive = (ms: number) => Math.max(ms, 5 * MIN);

const TTL = {
  crypto: 30_000,
  predictions: 2 * MIN,
  indices: MIN,
  stocks: MIN,
  sectors: 5 * MIN,
  summary: 10 * MIN, // backend caches 15 min
  research: 30 * MIN, // backend caches 6h
  discover: 5 * MIN, // backend caches 10 min
} as const;

export const useCrypto = () =>
  useQuery({
    queryKey: ["finance", "crypto"],
    queryFn: fetchCrypto,
    refetchInterval: TTL.crypto,
    staleTime: TTL.crypto,
    gcTime: keepAlive(TTL.crypto),
  });

export const useCryptoLeaderboard = () =>
  useQuery({
    queryKey: ["finance", "crypto", "leaderboard"],
    queryFn: fetchCryptoLeaderboard,
    refetchInterval: TTL.crypto,
    staleTime: TTL.crypto,
    gcTime: keepAlive(TTL.crypto),
  });

// Lumina Crypto 50 index — heavier (multi-call) + slow-moving, so a gentle 5-min cadence.
export const useCryptoIndex = (range: CryptoIndexRange = "6m") =>
  useQuery({
    queryKey: ["finance", "crypto", "index", range],
    queryFn: () => fetchCryptoIndex(range),
    // Keep the current chart visible while switching ranges (no error/empty flash on a cold range),
    // and retry transient CoinGecko rate-limits a couple times.
    placeholderData: keepPreviousData,
    retry: 2,
    refetchInterval: 5 * MIN,
    staleTime: 5 * MIN,
    gcTime: keepAlive(5 * MIN),
  });

export const usePredictions = () =>
  useQuery({
    queryKey: ["finance", "predictions"],
    queryFn: fetchPredictions,
    refetchInterval: TTL.predictions,
    staleTime: TTL.predictions,
    gcTime: keepAlive(TTL.predictions),
  });

export const useIndices = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "indices", market],
    queryFn: () => fetchIndices(market),
    refetchInterval: TTL.indices,
    staleTime: TTL.indices,
    gcTime: keepAlive(TTL.indices),
  });

export const useStocks = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "stocks", market],
    queryFn: () => fetchStocks(market),
    refetchInterval: TTL.stocks,
    staleTime: TTL.stocks,
    gcTime: keepAlive(TTL.stocks),
  });

export const useSectors = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "sectors", market],
    queryFn: () => fetchSectors(market),
    refetchInterval: TTL.sectors,
    staleTime: TTL.sectors,
    gcTime: keepAlive(TTL.sectors),
  });

export const useMarketSummary = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "summary", market],
    queryFn: () => fetchMarketSummary(market),
    refetchInterval: TTL.summary,
    staleTime: TTL.summary,
    gcTime: keepAlive(TTL.summary),
  });

export const useResearch = () =>
  useQuery({
    queryKey: ["finance", "research"],
    queryFn: fetchResearch,
    refetchInterval: TTL.research,
    staleTime: TTL.research,
    gcTime: keepAlive(TTL.research),
  });

export const useDiscover = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "discover", market],
    queryFn: () => fetchDiscover(market),
    refetchInterval: TTL.discover,
    staleTime: TTL.discover,
    gcTime: keepAlive(TTL.discover),
  });

// Market Insights ("Pulse") — slow-moving GREEN surfaces (backend caches 1–6h). A gentle
// 30-min client cadence; the cron warmer keeps the server cache hot so reads are instant.
const INSIGHTS_TTL = 30 * MIN;
export const useRecession = () =>
  useQuery({
    queryKey: ["finance", "recession"],
    queryFn: fetchRecession,
    refetchInterval: INSIGHTS_TTL,
    staleTime: INSIGHTS_TTL,
    gcTime: keepAlive(INSIGHTS_TTL),
  });
export const useGdelt = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "gdelt", market],
    queryFn: () => fetchGdelt(market),
    refetchInterval: INSIGHTS_TTL,
    staleTime: INSIGHTS_TTL,
    gcTime: keepAlive(INSIGHTS_TTL),
  });
export const useMood = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "mood", market],
    queryFn: () => fetchMood(market),
    refetchInterval: INSIGHTS_TTL,
    staleTime: INSIGHTS_TTL,
    gcTime: keepAlive(INSIGHTS_TTL),
  });
// The Daily Briefing is LLM-backed (backend caches 30 min). Don't refetch on focus — keep it
// stable for the session window so a tab revisit never re-triggers the slow generation.
export const useBriefing = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "briefing", market],
    queryFn: () => fetchBriefing(market),
    refetchInterval: INSIGHTS_TTL,
    staleTime: INSIGHTS_TTL,
    gcTime: keepAlive(INSIGHTS_TTL),
  });
// The public track-record scorecard — DB-backed, changes slowly (one call/day). 5-min cadence.
export const useScorecard = () =>
  useQuery({
    queryKey: ["finance", "scorecard"],
    queryFn: fetchScorecard,
    refetchInterval: 5 * MIN,
    staleTime: 5 * MIN,
    gcTime: keepAlive(5 * MIN),
  });
