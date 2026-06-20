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

// refetchInterval is aligned to the backend cache TTLs (crypto 30s, predictions 120s)
// so we poll roughly as often as the data can actually change — no faster.
export const useCrypto = () =>
  useQuery({ queryKey: ["finance", "crypto"], queryFn: fetchCrypto, refetchInterval: 30_000 });

export const usePredictions = () =>
  useQuery({
    queryKey: ["finance", "predictions"],
    queryFn: fetchPredictions,
    refetchInterval: 120_000,
  });

export const useIndices = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "indices", market],
    queryFn: () => fetchIndices(market),
    refetchInterval: 60_000,
  });

export const useStocks = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "stocks", market],
    queryFn: () => fetchStocks(market),
    refetchInterval: 60_000,
  });

export const useSectors = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "sectors", market],
    queryFn: () => fetchSectors(market),
    refetchInterval: 300_000,
  });

export const useMarketSummary = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "summary", market],
    queryFn: () => fetchMarketSummary(market),
    refetchInterval: 600_000, // 10 min; backend caches 15 min
  });

export const useResearch = () =>
  useQuery({
    queryKey: ["finance", "research"],
    queryFn: fetchResearch,
    refetchInterval: 1_800_000, // 30 min; backend caches 6h
  });

export const useDiscover = (market: Market = "us") =>
  useQuery({
    queryKey: ["finance", "discover", market],
    queryFn: () => fetchDiscover(market),
    refetchInterval: 300_000, // 5 min; backend caches 10 min
  });
