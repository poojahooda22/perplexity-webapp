import { useQuery } from "@tanstack/react-query";

import {
  fetchCrypto,
  fetchDiscover,
  fetchIndices,
  fetchMarketSummary,
  fetchPredictions,
  fetchResearch,
  fetchStocks,
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

export const useIndices = () =>
  useQuery({ queryKey: ["finance", "indices"], queryFn: fetchIndices, refetchInterval: 60_000 });

export const useStocks = () =>
  useQuery({ queryKey: ["finance", "stocks"], queryFn: fetchStocks, refetchInterval: 60_000 });

export const useMarketSummary = () =>
  useQuery({
    queryKey: ["finance", "summary"],
    queryFn: fetchMarketSummary,
    refetchInterval: 600_000, // 10 min; backend caches 15 min
  });

export const useResearch = () =>
  useQuery({
    queryKey: ["finance", "research"],
    queryFn: fetchResearch,
    refetchInterval: 1_800_000, // 30 min; backend caches 6h
  });

export const useDiscover = () =>
  useQuery({
    queryKey: ["finance", "discover"],
    queryFn: fetchDiscover,
    refetchInterval: 300_000, // 5 min; backend caches 10 min
  });
