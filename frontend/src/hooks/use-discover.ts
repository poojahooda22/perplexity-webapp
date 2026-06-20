import { useQuery } from "@tanstack/react-query";

import { fetchAcademicDiscover, fetchHealthDiscover, type Market } from "@/lib/discover-api";

// 30-min poll, aligned to the backend's 30-min cache (research changes slowly).
export const useAcademicDiscover = (market: Market = "us") =>
  useQuery({
    queryKey: ["discover", "academic", market],
    queryFn: () => fetchAcademicDiscover(market),
    refetchInterval: 1_800_000,
  });

// 10-min poll, aligned to the backend's 10-min cache (health news moves faster).
export const useHealthDiscover = (market: Market = "us") =>
  useQuery({
    queryKey: ["discover", "health", market],
    queryFn: () => fetchHealthDiscover(market),
    refetchInterval: 600_000,
  });
