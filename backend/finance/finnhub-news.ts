// ─────────────────────────────────────────────────────────────────────────
// Shared Finnhub news fetch for the LLM-grounded finance surfaces (Market Summary, Global
// Research). Finnhub's free /news feed is independent of Tavily's quota, so these surfaces keep
// working when Tavily is exhausted. Free-tier categories: general | forex | crypto | merger.
//
// LICENSING: the publisher `summary` is for MODEL GROUNDING only — callers synthesize an ORIGINAL
// item from it and link OUT to the publisher; they MUST NOT display the summary verbatim (AP v.
// Meltwater), the same care news.ts takes. commercialOk stays false on every surface that uses it.
// ─────────────────────────────────────────────────────────────────────────

const FINNHUB_NEWS = "https://finnhub.io/api/v1/news";

export type FinnhubCategory = "general" | "forex" | "crypto" | "merger";
export type FinnhubStory = { title: string; url: string; summary: string; datetime: number };

function finnhubKey(): string | null {
  return process.env.FINNHUB_API_KEY || process.env.FINHUB_API_KEY || null;
}

// Newest-first, de-duped by URL. Throws on a missing key / non-OK response so callers can decide
// how to degrade (Summary surfaces it; Research drops just that category via allSettled).
export async function fetchFinnhubNews(category: FinnhubCategory = "general", limit = 40): Promise<FinnhubStory[]> {
  const key = finnhubKey();
  if (!key) throw new Error("Finnhub key missing");
  const res = await fetch(`${FINNHUB_NEWS}?category=${category}&token=${key}`);
  if (!res.ok) throw new Error(`Finnhub news ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(raw)) throw new Error("Finnhub news: unexpected response");
  const seen = new Set<string>();
  const out: FinnhubStory[] = [];
  for (const a of [...raw].sort((x, y) => (Number(y.datetime) || 0) - (Number(x.datetime) || 0))) {
    const url = a.url ? String(a.url) : "";
    const title = a.headline ? String(a.headline) : "";
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, summary: String(a.summary ?? ""), datetime: Number(a.datetime) || 0 });
    if (out.length >= limit) break;
  }
  return out;
}