// ─────────────────────────────────────────────────────────────────────────
// Global Research — AI-synthesized, multi-source, cited analytical notes by category.
//
// Legally this is the "transformative multi-source synthesis" pattern (per the fintech-webapp
// research-data-sourcing KB): Tavily gathers ≥3 independent sources → the AI gateway writes an
// ORIGINAL note blending them with analysis → we cite + link out to the sources. We never
// reproduce a single source's wording. Cached upstream (TTL in routes.ts) so the LLM + Tavily
// run only ~once per refresh window, not per view.
// ─────────────────────────────────────────────────────────────────────────

import { tavily } from "@tavily/core";
import { generateObject } from "ai";
import { z } from "zod";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

export const RESEARCH_CATEGORIES: { key: string; label: string; query: string }[] = [
  { key: "rates", label: "Rates", query: "global interest rates Fed ECB BoJ central banks Treasury bond yields outlook" },
  { key: "credit", label: "Credit", query: "corporate credit spreads high yield investment grade private credit default cycle" },
  { key: "equities", label: "Equities", query: "global equity markets S&P 500 valuations earnings sector rotation outlook" },
  { key: "economics", label: "Economics", query: "macroeconomy inflation CPI GDP growth labor market recession risk outlook" },
  { key: "market-structure", label: "Market Structure", query: "market structure ETFs liquidity options flow CLOs market plumbing" },
  { key: "digital-assets", label: "Digital Assets", query: "crypto stablecoins tokenization Bitcoin Ethereum digital assets regulation" },
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

export async function fetchResearchNote(categoryKey: string): Promise<ResearchNote> {
  const cat = RESEARCH_CATEGORIES.find((c) => c.key === categoryKey);
  if (!cat) throw new Error(`unknown research category: ${categoryKey}`);

  const search = await tvly.search(`${cat.query} 2026 analysis`, {
    searchDepth: "basic",
    topic: "news",
    days: 10,
    maxResults: 8,
  });
  const results = search.results ?? [];
  const sources: ResearchSource[] = results.map((r) => ({ title: r.title, url: r.url }));
  const context = results
    .map((r, i) => {
      let host = r.url;
      try {
        host = new URL(r.url).hostname.replace(/^www\./, "");
      } catch {
        /* keep url */
      }
      return `[${i + 1}] ${r.title} (${host})\n${r.content}`;
    })
    .join("\n\n");

  const { object } = await generateObject({
    // Sonnet for the flagship "JPM-grade" content; result is cached, so cost stays low.
    model: "anthropic/claude-sonnet-4.6",
    schema: NoteSchema,
    prompt:
      `You are a markets strategist writing a concise, institution-grade research note on "${cat.label}". ` +
      `From the multi-source snippets below, synthesize an ORIGINAL note: a sharp title, a 2-sentence thesis, ` +
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

// All category notes, generated in parallel. One slow/failed category drops out (allSettled)
// rather than sinking the whole surface.
export async function fetchAllResearch(): Promise<{ notes: ResearchNote[] }> {
  const settled = await Promise.allSettled(RESEARCH_CATEGORIES.map((c) => fetchResearchNote(c.key)));
  const notes = settled
    .filter((s): s is PromiseFulfilledResult<ResearchNote> => s.status === "fulfilled")
    .map((s) => s.value);
  return { notes };
}
