import { useQuery } from "@tanstack/react-query";

import {
  fetchCrypto,
  fetchDiscover,
  fetchIndices,
  fetchMarketSummary,
  fetchPredictions,
  fetchResearch,
  fetchSectors,
  fetchStocks,
  type Market,
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
