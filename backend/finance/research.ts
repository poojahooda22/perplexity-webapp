// ─────────────────────────────────────────────────────────────────────────
// Global Research — AI-synthesized, multi-source, cited analytical notes by category.
//
// Legally this is the "transformative multi-source synthesis" pattern (per the fintech-webapp
// research-data-sourcing KB): we gather ≥3 independent market-news stories → the AI gateway writes
// an ORIGINAL note blending them with analysis → we cite + link out to the sources. We never
// reproduce a single source's wording. Cached upstream (TTL in routes.ts) so the LLM run happens
// only ~once per refresh window, not per view.
//
// SOURCING: stories come from Finnhub's free /news feed (general for macro/markets, crypto for
// digital assets) — independent of Tavily's quota, so Research keeps working when Tavily is
// exhausted. Finnhub's feed has no per-topic search, so each category is built by keyword-filtering
// the shared pool; a category with too few relevant stories is DROPPED (allSettled) rather than
// synthesized from off-topic news — honest thin coverage beats invented specificity. The publisher
// `summary` is model grounding only; sources expose title + link, never the body (AP v. Meltwater).
// ─────────────────────────────────────────────────────────────────────────

import { generateObject } from "ai";
import { z } from "zod";

import { fetchFinnhubNews, type FinnhubStory } from "./finnhub-news.js";

export const RESEARCH_CATEGORIES: { key: string; label: string; keywords: string[]; crypto?: boolean }[] = [
  { key: "rates", label: "Rates", keywords: ["rate", "fed", "federal reserve", "ecb", "boj", "central bank", "treasury", "yield", "bond", "monetary"] },
  { key: "credit", label: "Credit", keywords: ["credit", "spread", "high yield", "investment grade", "default", "loan", "debt", "leverage", "junk", "lending"] },
  { key: "equities", label: "Equities", keywords: ["stock", "equit", "s&p", "nasdaq", "dow", "shares", "earnings", "valuation", "sector", "index", "ipo"] },
  { key: "economics", label: "Economics", keywords: ["inflation", "cpi", "gdp", "growth", "jobs", "labor", "labour", "unemployment", "economy", "economic", "recession", "consumer", "spending"] },
  { key: "market-structure", label: "Market Structure", keywords: ["etf", "liquidity", "option", "futures", "exchange", "clearing", "listing", "volatility", "trading", "derivative"] },
  { key: "digital-assets", label: "Digital Assets", keywords: ["bitcoin", "ethereum", "crypto", "stablecoin", "token", "blockchain", "defi", "coin"], crypto: true },
];

const NoteSchema = z.object({
  title: z.string().describe("a sharp, specific headline for the note"),
  summary: z.string().describe("a 2-sentence thesis"),
  keyPoints: z.array(z.string()).min(3).max(5).describe("quantified takeaways, each one data point with numbers"),
  body: z.array(z.string()).min(2).max(4).describe("short analytical paragraphs that blend the sources"),
});

export type ResearchSource = { title: string; url: string };
export type ResearchNote = {
  category: string;
  label: string;
  title: string;
  summary: string;
  keyPoints: string[];
  body: string[];
  sources: ResearchSource[];
  updatedAt: string;
};

// Need at least this many relevant stories to synthesize a grounded note; below it the category is
// dropped rather than written from thin/off-topic news.
const MIN_STORIES = 3;
const MAX_STORIES = 10;

function relevant(stories: FinnhubStory[], keywords: string[]): FinnhubStory[] {
  return stories.filter((s) => {
    const hay = `${s.title} ${s.summary}`.toLowerCase();
    return keywords.some((k) => hay.includes(k));
  });
}

export async function fetchResearchNote(categoryKey: string, stories: FinnhubStory[]): Promise<ResearchNote> {
  const cat = RESEARCH_CATEGORIES.find((c) => c.key === categoryKey);
  if (!cat) throw new Error(`unknown research category: ${categoryKey}`);
  if (stories.length < MIN_STORIES) throw new Error(`thin coverage for ${cat.label} (${stories.length} stories)`);

  const sources: ResearchSource[] = stories.map((s) => ({ title: s.title, url: s.url }));
  const context = stories
    .map((s, i) => {
      let host = s.url;
      try {
        host = new URL(s.url).hostname.replace(/^www\./, "");
      } catch {
        /* keep url */
      }
      return `[${i + 1}] ${s.title} (${host})\n${s.summary}`;
    })
    .join("\n\n");

  const { object } = await generateObject({
    // Sonnet for the flagship "JPM-grade" content; result is cached, so cost stays low.
    model: "anthropic/claude-sonnet-4.6",
    schema: NoteSchema,
    prompt:
      `You are a markets strategist writing a concise, institution-grade research note on "${cat.label}". ` +
      `From the multi-source market-news snippets below, synthesize an ORIGINAL note: a sharp title, a 2-sentence thesis, ` +
      `3-5 quantified key points (specific numbers/levels), and 2-4 short analytical paragraphs that BLEND the ` +
      `sources into a new view with your own analysis. Be factual and specific with numbers. ` +
      `CRITICAL: do NOT reproduce any single source's wording and do NOT summarize just one article — ` +
      `synthesize across multiple sources. If the snippets are thin, write a shorter note rather than inventing facts.\n\n` +
      context,
  });

  return {
    category: cat.key,
    label: cat.label,
    title: object.title,
    summary: object.summary,
    keyPoints: object.keyPoints,
    body: object.body,
    sources,
    updatedAt: new Date().toISOString(),
  };
}

// All category notes. Gathers the Finnhub pools ONCE (general for macro/markets, crypto for digital
// assets), then synthesizes each category from its relevant subset in parallel. One slow/failed/thin
// category drops out (allSettled) rather than sinking the whole surface.
export async function fetchAllResearch(): Promise<{ notes: ResearchNote[] }> {
  const [generalPool, cryptoPool] = await Promise.all([
    fetchFinnhubNews("general", 60).catch(() => [] as FinnhubStory[]),
    fetchFinnhubNews("crypto", 40).catch(() => [] as FinnhubStory[]),
  ]);

  const settled = await Promise.allSettled(
    RESEARCH_CATEGORIES.map((c) => {
      const pool = c.crypto ? cryptoPool : relevant(generalPool, c.keywords);
      return fetchResearchNote(c.key, pool.slice(0, MAX_STORIES));
    }),
  );
  const notes = settled
    .filter((s): s is PromiseFulfilledResult<ResearchNote> => s.status === "fulfilled")
    .map((s) => s.value);
  return { notes };
}