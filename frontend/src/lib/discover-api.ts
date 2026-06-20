import { BACKEND_URL } from "./config";
import type { DiscoverArticle, DiscoverPayload, Market } from "./finance-api";

// Reuse the finance Discover card types — every Discover surface shares the same shape.
export type { DiscoverArticle, DiscoverPayload, Market };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

const marketQuery = (market: Market) => (market === "in" ? "?market=in" : "");

// Academic "latest research" feed (OpenAlex, CC0). ?market=in → India-affiliated research.
export const fetchAcademicDiscover = (market: Market = "us") =>
  getJson<DiscoverPayload>(`/discover/academic${marketQuery(market)}`);