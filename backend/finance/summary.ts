// ─────────────────────────────────────────────────────────────────────────
// Market Summary — AI-generated, source-cited market news for the Finance home.
// Fresh market-moving stories are gathered (US: Finnhub /news, the same feed powering the
// Discover carousel; India: Tavily scoped to NSE/BSE publishers — Finnhub's feed is US/global)
// → the AI gateway turns them into a few concise headline+body items grounded in those snippets.
// Cached upstream (TTL in routes.ts) so the LLM + news fetch run only ~once per refresh window.
//
// US no longer depends on Tavily, so the home Market Summary is independent of Tavily's quota.
//
// LICENSING: a publisher's snippet/summary is passed to the model ONLY as grounding context to
// synthesize an ORIGINAL item — it is NEVER returned in the displayed source `content` (the drawer
// shows title + link only). Displaying a publisher's lede/body is the infringing pattern (AP v.
// Meltwater); the same care news.ts takes. commercialOk stays false.
// ─────────────────────────────────────────────────────────────────────────

import { tavily } from "@tavily/core";
import { generateObject } from "ai";
import { z } from "zod";

import { fetchFinnhubNews } from "./finnhub-news.js";
import type { Market, Provenance } from "./sources.js";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// One gathered story. `displayContent` is safe to show (empty for Finnhub — title+link only);
// `grounding` is the snippet/body fed to the model and never rendered.
type GatheredStory = { title: string; url: string; displayContent: string; grounding: string };

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

// US market news from Finnhub's general feed (the same key powering the Discover carousel). The
// publisher `summary` is kept ONLY as model grounding — never put in displayContent. Independent
// of Tavily's quota, so the US home summary keeps working when Tavily is exhausted.
async function fetchUsStories(): Promise<GatheredStory[]> {
  const news = await fetchFinnhubNews("general", 12);
  return news.map((n) => ({ title: n.title, url: n.url, displayContent: "", grounding: n.summary.slice(0, 400) }));
}

// India market news from Tavily, scoped to NSE/BSE stories (Finnhub's feed is US/global). Tavily
// search snippets are short search excerpts (not a publisher's full body), kept as the original code did.
async function fetchIndiaStories(): Promise<GatheredStory[]> {
  const search = await tvly.search(
    "Indian stock market today: NIFTY 50, S&P BSE Sensex, Nifty Bank, the RBI, the rupee, top NSE and BSE movers — top market-moving news",
    { searchDepth: "basic", topic: "news", days: 3, maxResults: 8 },
  );
  return (search.results ?? []).map((r) => {
    const snippet = (r.content ?? "").slice(0, 240);
    return { title: r.title, url: r.url, displayContent: snippet, grounding: snippet };
  });
}

export async function fetchMarketSummary(market: Market = "us"): Promise<SummaryPayload> {
  // Editorial focus switches with the market so India reads as Indian market news.
  const focus =
    market === "in"
      ? "(NIFTY 50 / Sensex / Nifty Bank, the RBI and rates, the rupee, big NSE/BSE movers, macro)"
      : "(indices, the Fed/rates, big movers, crypto, macro/oil)";

  const stories = market === "in" ? await fetchIndiaStories() : await fetchUsStories();
  const sources: SummarySource[] = stories.map((s) => ({ title: s.title, url: s.url, content: s.displayContent }));
  const context = stories.map((s, i) => `[${i + 1}] ${s.title}\n${s.grounding}`).join("\n\n");

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
      source: market === "in" ? "Tavily + AI" : "Finnhub + AI",
      commercialOk: false,
      attribution: "AI summary of web sources",
    },
  };
}
