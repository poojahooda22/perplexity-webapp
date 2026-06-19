// ─────────────────────────────────────────────────────────────────────────
// Discover — financial-news cards from Finnhub /news (general category).
//
// LEGAL SHAPE (enforced here): we expose ONLY headline + source + link + image +
// timestamp. The publisher's `summary` text is deliberately DROPPED and never displayed
// (displaying a publisher's lede/body is the infringing pattern — AP v. Meltwater). Cards
// link OUT to the publisher's own URL. This is the Google-News / Perplexity-Discover model.
//
// LICENSING: Finnhub's free tier is personal/non-commercial. The live feed carries
// Reuters/CNBC/Bloomberg, so a PUBLIC launch needs written display clearance (or a paid
// commercial plan) from Finnhub — commercialOk stays false until then. Demo/internal use is fine.
// ─────────────────────────────────────────────────────────────────────────

import type { Provenance } from "./sources.js";

const FINNHUB_NEWS = "https://finnhub.io/api/v1/news";

function finnhubKey(): string | null {
  return process.env.FINNHUB_API_KEY || process.env.FINHUB_API_KEY || null;
}

export type DiscoverArticle = {
  id: string;
  title: string;
  source: string;
  url: string;
  image: string | null;
  publishedAt: string;
  category: string;
};
export type DiscoverPayload = { articles: DiscoverArticle[]; provenance: Provenance; needsKey?: boolean };

// Canonicalize a URL for dedup: lowercase host, strip tracking params + hash + trailing slash.
function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ref", "mc_cid", "igshid"]) {
      url.searchParams.delete(k);
    }
    const base = `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname}`.replace(/\/$/, "");
    const qs = url.searchParams.toString();
    return qs ? `${base}?${qs}` : base;
  } catch {
    return u;
  }
}

const MAX_ARTICLES = 18;

export async function fetchDiscover(): Promise<DiscoverPayload> {
  const provenance: Provenance = {
    source: "Finnhub",
    commercialOk: false, // free tier = personal use; get written display clearance before public launch
    attribution: "News via Finnhub — headlines link to publishers",
  };
  const key = finnhubKey();
  if (!key) return { articles: [], provenance, needsKey: true };

  const res = await fetch(`${FINNHUB_NEWS}?category=general&token=${key}`);
  if (!res.ok) throw new Error(`Finnhub news ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, any>>;
  if (!Array.isArray(raw)) throw new Error("Finnhub news: unexpected response");

  const seen = new Set<string>();
  const articles: DiscoverArticle[] = [];
  // Newest first.
  for (const a of [...raw].sort((x, y) => (Number(y.datetime) || 0) - (Number(x.datetime) || 0))) {
    if (!a.url || !a.headline) continue;
    const urlKey = canonicalUrl(String(a.url));
    const titleKey = String(a.headline).toLowerCase().trim();
    if (seen.has(urlKey) || seen.has(titleKey)) continue; // dedup by URL + exact title
    seen.add(urlKey);
    seen.add(titleKey);
    articles.push({
      id: String(a.id ?? urlKey),
      title: String(a.headline),
      source: String(a.source ?? ""),
      url: String(a.url),
      image: a.image ? String(a.image) : null, // hotlinked thumbnail (not re-hosted)
      publishedAt: a.datetime
        ? new Date(Number(a.datetime) * 1000).toISOString()
        : new Date().toISOString(),
      category: String(a.category ?? "general"),
      // NOTE: a.summary (publisher text) intentionally NOT included — never displayed.
    });
    if (articles.length >= MAX_ARTICLES) break;
  }
  return { articles, provenance };
}
