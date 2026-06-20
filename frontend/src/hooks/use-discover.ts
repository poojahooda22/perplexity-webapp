import { useQuery } from "@tanstack/react-query";

import { fetchAcademicDiscover, type Market } from "@/lib/discover-api";

// 30-min poll, aligned to the backend's 30-min cache (research changes slowly).
export const useAcademicDiscover = (market: Market = "us") =>
  useQuery({
    queryKey: ["discover", "academic", market],
    queryFn: () => fetchAcademicDiscover(market),
    refetchInterval: 1_800_000,
  });
