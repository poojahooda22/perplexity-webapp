// ─────────────────────────────────────────────────────────────────────────
// Finance agent TOOLS — model-driven function calls (the pi "tools" idea, on the
// Vercel AI SDK). Each wraps an existing finance fetcher THROUGH the cache so the
// agent loop can't blow a vendor's free-tier credit budget: the same args in a window
// share one upstream call (getOrRefresh + its in-flight de-dupe).
//
// buildFinanceTools() returns a FRESH tool set per request plus a `sources` accumulator:
// financeWebSearch appends the web results it finds so the route can emit them as the
// <SOURCES> wire tail (and hands the model GLOBAL [n] numbers so its citations line up).
// ─────────────────────────────────────────────────────────────────────────
import { tool } from "ai";
import { z } from "zod";
import { tavily } from "@tavily/core";
import { getOrRefresh, type CacheResult } from "../lib/cache.js";
import { fetchCryptoMarkets, fetchIndices, fetchQuotes } from "./sources.js";
import { loadSkill } from "./skills.js";
import { withGuard, withinBudget, RateBudgetError } from "./hooks.js";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// Fetch through the cache, enforcing the per-minute vendor budget ONLY on a real upstream call:
// getOrRefresh runs the fetcher just on a MISS, so the budget check inside it can't be charged
// by a cache HIT. If over budget AND nothing cached to serve stale, getOrRefresh rethrows the
// RateBudgetError and we report { ok:false } → the tool returns a typed `unavailable`.
// NOTE: we deliberately do NOT thread the request's AbortSignal into the fetcher — the fetcher
// is SHARED across concurrent callers (in-flight de-dupe), so one caller's disconnect must not
// abort the others' fetch. Client-disconnect cancellation is handled at the streamText level.
async function cachedToolFetch<T>(
  name: string,
  perMinute: number,
  key: string,
  ttlSec: number,
  fetcher: () => Promise<T>,
): Promise<{ ok: true; r: CacheResult<T> } | { ok: false }> {
  try {
    const r = await getOrRefresh(key, ttlSec, () => {
      if (!withinBudget(name, perMinute)) throw new RateBudgetError(name);
      return fetcher();
    });
    return { ok: true, r };
  } catch (e) {
    if (e instanceof RateBudgetError) return { ok: false };
    throw e;
  }
}

/** A web source surfaced by financeWebSearch, collected for the <SOURCES> tail. */
export interface AgentSource {
  title?: string;
  url: string;
  content?: string;
}

export function buildFinanceTools() {
  // Per-request accumulator: financeWebSearch pushes here so the route emits the exact
  // numbered source list the model cited. Fresh array per call = no cross-request bleed.
  const sources: AgentSource[] = [];

  const getQuote = tool({
    description:
      "Get the latest price, daily change, and percent change for one or more US stock/ETF " +
      "tickers (e.g. AAPL, MSFT, NVDA). Use for any question about a stock's current price or " +
      "today's move. Does NOT cover crypto, indices, or non-US listings.",
    inputSchema: z.object({
      symbols: z
        .array(z.string())
        .min(1)
        .max(8)
        .describe("Ticker symbols, e.g. ['MSFT','NVDA']. US equities/ETFs only."),
    }),
    execute: async ({ symbols }) => {
      const list = [...new Set(symbols.map((s) => s.toUpperCase()))].sort();
      const key = `finance:quote:${list.join(",")}`;
      const res = await cachedToolFetch("getQuote", 6, key, 60, () => fetchQuotes(list));
      if (!res.ok) return { unavailable: "Live stock quotes are rate-limited right now — try again shortly." };
      const r = res.r;
      if (r.data.needsKey) {
        return { error: "Stock quotes are unavailable: TWELVE_DATA_API_KEY is not configured." };
      }
      return {
        items: r.data.items,
        provenance: r.data.provenance,
        fetchedAt: new Date(r.fetchedAt).toISOString(),
        stale: r.stale,
      };
    },
  });

  const getCrypto = tool({
    description:
      "Get price, 24h percent change, and market cap for one or more cryptocurrencies by " +
      "CoinGecko coin id (e.g. bitcoin, ethereum, solana). Use for crypto price or compare questions.",
    inputSchema: z.object({
      ids: z
        .array(z.string())
        .min(1)
        .max(15)
        .describe("CoinGecko coin ids (lowercase), e.g. ['bitcoin','ethereum']."),
    }),
    execute: async ({ ids }) => {
      const list = [...new Set(ids.map((s) => s.toLowerCase()))].sort();
      const key = `finance:cryptomkt:${list.join(",")}`;
      const res = await cachedToolFetch("getCrypto", 20, key, 30, () => fetchCryptoMarkets(list));
      if (!res.ok) return { unavailable: "Live crypto data is rate-limited right now — try again shortly." };
      const r = res.r;
      return {
        coins: r.data.coins,
        provenance: r.data.provenance,
        fetchedAt: new Date(r.fetchedAt).toISOString(),
        stale: r.stale,
      };
    },
  });

  const getIndices = tool({
    description:
      "Get the latest values for the major US market indices: S&P 500, NASDAQ, Dow Jones, and the " +
      "VIX (volatility). Use for 'how are the markets doing today' / index-level questions.",
    inputSchema: z.object({}),
    execute: async () => {
      const res = await cachedToolFetch("getIndices", 12, "finance:indices", 300, () => fetchIndices());
      if (!res.ok) return { unavailable: "Live index data is rate-limited right now — try again shortly." };
      const r = res.r;
      return {
        items: r.data.items,
        provenance: r.data.provenance,
        fetchedAt: new Date(r.fetchedAt).toISOString(),
        stale: r.stale,
      };
    },
  });

  const financeWebSearch = tool({
    description:
      "Search the web for finance news, analysis, or context (earnings, the Fed, macro, why a " +
      "stock moved, company events). Use when the question needs news or explanation beyond live " +
      "prices. Returns numbered sources — cite them inline as [n].",
    inputSchema: z.object({
      query: z.string().describe("A focused finance search query."),
    }),
    execute: async ({ query }) => {
      // financeWebSearch isn't cached (every call is a fresh Tavily query), so the budget is
      // enforced per-call here — correct, since each call really does spend a Tavily credit.
      if (!withinBudget("financeWebSearch", 10)) {
        return { unavailable: "Web search is rate-limited right now — try again shortly." };
      }
      const resp = await tvly.search(query, {
        searchDepth: "basic",
        topic: "news",
        days: 7,
        maxResults: 6,
      });
      const results = (resp.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        content: (r.content ?? "").slice(0, 800),
      }));
      // Append to the shared accumulator and hand back GLOBAL [n] numbers so the model's
      // citations match the <SOURCES> tail the client renders.
      const numbered = results.map((r) => {
        sources.push(r);
        return { n: sources.length, title: r.title, url: r.url, snippet: r.content };
      });
      return { sources: numbered };
    },
  });

  // Each data tool is wrapped in the budget/log/disclaimer hook. Budgets are process-global
  // (the vendor API keys are shared across all users), tuned under each free-tier cap:
  // Twelve Data 8/min → getQuote 6; CoinGecko demo 100/min → getCrypto 20; Yahoo (no key) →
  // getIndices 12; Tavily → financeWebSearch 10. loadSkill is local, so it needs no guard.
  return {
    tools: {
      getQuote: withGuard("getQuote", getQuote),
      getCrypto: withGuard("getCrypto", getCrypto),
      getIndices: withGuard("getIndices", getIndices),
      financeWebSearch: withGuard("financeWebSearch", financeWebSearch),
      loadSkill,
    },
    sources,
  };
}
