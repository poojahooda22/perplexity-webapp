// ─────────────────────────────────────────────────────────────────────────
// Market Summary — AI-generated, source-cited market news for the Finance home.
// Tavily (news topic) gathers fresh market-moving stories → the AI gateway turns them
// into a few concise headline+body items grounded in those snippets. Cached upstream
// (TTL in routes.ts) so the LLM + Tavily run only ~once per refresh window, not per view.
// ─────────────────────────────────────────────────────────────────────────

import { tavily } from "@tavily/core";
import { generateObject } from "ai";
import { z } from "zod";

import type { Market, Provenance } from "./sources.js";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

export type SummaryItem = { headline: string; body: string };
export type SummarySource = { title: string; url: string; content: string };
export type SummaryPayload = {
  items: SummaryItem[];
  sources: SummarySource[];
  updatedAt: string;
  provenance: Provenance;
};

const Schema = z.object({
  items: z
    .array(
      z.object({
        headline: z.string().describe("a punchy one-line news headline"),
        body: z.string().describe("1-2 sentence explanation grounded in the snippets, with numbers where present"),
      }),
    )
    .min(3)
    .max(6),
});

export async function fetchMarketSummary(market: Market = "us"): Promise<SummaryPayload> {
  // The query + editorial focus switch with the market so India shows Indian market news.
  const query =
    market === "in"
      ? "Indian stock market today: NIFTY 50, S&P BSE Sensex, Nifty Bank, the RBI, the rupee, top NSE and BSE movers — top market-moving news"
      : "US stock market today: S&P 500, Nasdaq, Dow, Treasury yields, the Fed, oil, and crypto — top market-moving news";
  const focus =
    market === "in"
      ? "(NIFTY 50 / Sensex / Nifty Bank, the RBI and rates, the rupee, big NSE/BSE movers, macro)"
      : "(indices, the Fed/rates, big movers, crypto, macro/oil)";

  const search = await tvly.search(query, { searchDepth: "basic", topic: "news", days: 3, maxResults: 8 });
  const results = search.results ?? [];
  const sources: SummarySource[] = results.map((r) => ({
    title: r.title,
    url: r.url,
    content: (r.content ?? "").slice(0, 240), // short snippet for the sources drawer
  }));
  const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`).join("\n\n");

  const { object } = await generateObject({
    // Bare string id → routed through the Vercel AI Gateway (AI_GATEWAY_API_KEY). Haiku is
    // cheap + fast and the result is cached, so cost is minimal.
    model: "anthropic/claude-haiku-4.5",
    schema: Schema,
    prompt:
      `You are a markets editor. From the dated news snippets below, write 5 concise "Market Summary" ` +
      `items (headline + 1-2 sentence body) covering the day's most important market-moving stories ` +
      `${focus}. Be factual and specific with numbers where present. Do NOT invent anything not ` +
      `supported by the snippets.\n\n${context}`,
  });

  return {
    items: object.items,
    sources,
    updatedAt: new Date().toISOString(),
    provenance: {
      source: "Tavily + AI",
      commercialOk: false,
      attribution: "AI summary of web sources",
    },
  };
}
