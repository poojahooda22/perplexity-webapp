import { useQuery } from "@tanstack/react-query";

import { fetchAcademicDiscover, fetchHealthDiscover, type Market } from "@/lib/discover-api";

// staleTime matches refetchInterval so a tab revisit inside the window is served from cache
// (no refetch); gcTime keeps the cached feed alive across the tab unmount for the same window.
const MIN = 60_000;

// 30-min poll, aligned to the backend's 30-min cache (research changes slowly).
export const useAcademicDiscover = (market: Market = "us") =>
  useQuery({
    queryKey: ["discover", "academic", market],
    queryFn: () => fetchAcademicDiscover(market),
    refetchInterval: 30 * MIN,
    staleTime: 30 * MIN,
    gcTime: 30 * MIN,
  });

// 10-min poll, aligned to the backend's 10-min cache (health news moves faster).
export const useHealthDiscover = (market: Market = "us") =>
  useQuery({
    queryKey: ["discover", "health", market],
    queryFn: () => fetchHealthDiscover(market),
    refetchInterval: 10 * MIN,
    staleTime: 10 * MIN,
    gcTime: 10 * MIN,
  });