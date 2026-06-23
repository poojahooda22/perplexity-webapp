// ─────────────────────────────────────────────────────────────────────────
// Health Discover — latest health/medical news cards.
//
// Sources (reuse existing keys — no new provider needed):
//   • PRIMARY: NewsData.io category=health (real per-article images; country=in for India).
//   • FALLBACK: a Tavily news search scoped to health publishers + WHO/CDC/ICMR/PIB, so the
//     feed ALWAYS works even without a NewsData key (the same pattern as finance India).
//
// LEGAL SHAPE (same ship-rule as finance Discover): headline + source + outbound link +
// (hotlinked, never re-hosted) image + timestamp. Publisher body/snippet is NEVER displayed.
// commercialOk stays false for all publisher-derived content until a display licence is signed.
// ─────────────────────────────────────────────────────────────────────────

import { tavily } from "@tavily/core";

import {
  canonicalUrl,
  fetchOgImage,
  finalizeArticles,
  hostOf,
  toIso,
  type DiscoverArticle,
  type DiscoverPayload,
  type Market,
  type Provenance,
} from "./shared.js";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
const NEWSDATA_LATEST = "https://newsdata.io/api/1/latest";

function newsdataKey(): string | null {
  return process.env.NEWSDATA_API_KEY || null;
}

// Trusted health publishers + global health organizations (WHO/CDC/NIH) for the Tavily lane.
const GLOBAL_HEALTH_DOMAINS = [
  "who.int", "cdc.gov", "nih.gov", "statnews.com", "medicalnewstoday.com",
  "healthline.com", "nature.com", "sciencedaily.com", "kffhealthnews.org", "medscape.com",
];
const INDIA_HEALTH_DOMAINS = [
  "who.int", "icmr.gov.in", "pib.gov.in", "mohfw.gov.in", "thehindu.com",
  "timesofindia.indiatimes.com", "indianexpress.com", "ndtv.com", "livemint.com",
  "hindustantimes.com", "downtoearth.org.in", "theprint.in",
];

type NewsDataItem = {
  article_id?: string;
  title?: string;
  link?: string;
  image_url?: string | null;
  source_name?: string | null;
  source_id?: string | null;
  pubDate?: string;
  category?: string[];
  country?: string[]; // NewsData per-article publish origin, e.g. ["india"], ["united states of america"]
};

// How many cards the feed serves up-front (was 18). Health requires every card to carry an image.
const HEALTH_TARGET = 20;

// The GLOBAL feed must NOT surface India-published outlets (e.g. "Business News India") — those
// belong to the India feed. NewsData tags each article with a `country` list; treat an article as
// India-origin if that list names India. (The India feed is queried with country=in and is kept.)
function isIndiaOrigin(it: NewsDataItem): boolean {
  return (it.country ?? []).some((c) => String(c).toLowerCase().includes("india"));
}
type NewsDataResponse = { status?: string; results?: NewsDataItem[]; message?: string };

async function callNewsData(url: string): Promise<NewsDataResponse> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  const body = (await res.json().catch(() => ({}))) as NewsDataResponse;
  if (!res.ok || body.status === "error") {
    throw new Error(`NewsData ${res.status}: ${body.message ?? "request failed"}`);
  }
  return body;
}

export async function fetchHealthNewsData(market: Market): Promise<DiscoverPayload> {
  const provenance: Provenance = {
    source: "NewsData.io",
    commercialOk: false,
    attribution: "Health news via NewsData.io — headlines link to publishers",
  };
  const key = newsdataKey();
  if (!key) return { articles: [], provenance, needsKey: true };

  const enc = encodeURIComponent;
  // image=1 → only articles WITH an image; removeduplicate=1 → server-side dedup.
  const base = `${NEWSDATA_LATEST}?apikey=${enc(key)}&language=en&image=1&removeduplicate=1`;
  const filteredUrl = market === "in" ? `${base}&country=in&category=health` : `${base}&category=health`;
  // country/category can be plan-gated on some keys → retry with a pure keyword query.
  const keywordUrl = `${base}&q=${enc(market === "in" ? "India health hospital ICMR vaccine disease" : "health medicine disease vaccine WHO outbreak")}`;

  let data: NewsDataResponse;
  try {
    data = await callNewsData(filteredUrl);
  } catch (e) {
    console.warn("[discover] health NewsData filtered query failed, retrying keyword-only:", e instanceof Error ? e.message : e);
    data = await callNewsData(keywordUrl);
  }

  const articles: DiscoverArticle[] = [];
  for (const it of data.results ?? []) {
    if (!it.link || !it.title) continue;
    // Global feed: drop India-published outlets so they don't leak in (the India feed keeps them).
    if (market !== "in" && isIndiaOrigin(it)) continue;
    articles.push({
      id: it.article_id || canonicalUrl(String(it.link)),
      title: String(it.title),
      source: it.source_name || it.source_id || hostOf(String(it.link)),
      url: String(it.link),
      image: it.image_url ?? null,
      publishedAt: toIso(it.pubDate),
      category: it.category?.[0] ?? "health",
    });
  }
  return { articles: finalizeArticles(articles, { max: HEALTH_TARGET, requireImage: true }), provenance };
}

async function fetchHealthTavily(market: Market): Promise<DiscoverPayload> {
  const provenance: Provenance = {
    source: "Tavily (health news)",
    commercialOk: false,
    attribution: "Health news via Tavily — headlines link to publishers",
  };
  const domains = market === "in" ? INDIA_HEALTH_DOMAINS : GLOBAL_HEALTH_DOMAINS;
  const query =
    market === "in"
      ? "India health news today: hospitals, ICMR, vaccines, disease outbreaks, public health, WHO India"
      : "latest health and medical news today: disease outbreaks, public health, WHO, CDC, medicine, wellness, viruses";

  const search = await tvly.search(query, {
    topic: "news",
    days: 7,
    maxResults: 25,
    searchDepth: "basic",
    includeDomains: domains,
  });

  const articles: DiscoverArticle[] = [];
  for (const r of search.results ?? []) {
    if (!r.url || !r.title) continue;
    const raw = (r as Record<string, unknown>).publishedDate ?? (r as Record<string, unknown>).published_date;
    articles.push({
      id: canonicalUrl(String(r.url)),
      title: String(r.title),
      source: hostOf(String(r.url)),
      url: String(r.url),
      image: null, // Tavily returns no hero image → hotlink the publisher's og:image below
      publishedAt: toIso(raw),
      category: "health",
      // r.content (publisher snippet) intentionally NOT included — never displayed.
    });
  }
  const ogImages = await Promise.all(articles.map((a) => fetchOgImage(a.url)));
  articles.forEach((a, i) => {
    a.image = ogImages[i] ?? null;
  });
  return { articles: finalizeArticles(articles, { max: HEALTH_TARGET, requireImage: true }), provenance };
}

// Orchestrator: prefer NewsData (real images). If it returns a full page (≥ HEALTH_TARGET) use it;
// if it returns a PARTIAL page (e.g. after the global India-origin filter trims it), top it up with
// the Tavily lane so the feed reliably serves HEALTH_TARGET image-bearing cards; if NewsData has no
// key / fails / returns nothing, fall back to Tavily alone so the carousel always has news.
export async function fetchHealthDiscover(market: Market = "us"): Promise<DiscoverPayload> {
  let primary: DiscoverPayload | null = null;
  if (newsdataKey()) {
    try {
      const nd = await fetchHealthNewsData(market);
      if (nd.articles.length >= HEALTH_TARGET) return nd; // already a full page
      if (nd.articles.length > 0) primary = nd; // partial → merge with Tavily below
    } catch (e) {
      console.warn("[discover] health NewsData failed, falling back to Tavily:", e instanceof Error ? e.message : e);
    }
  }
  const fallback = await fetchHealthTavily(market);
  if (!primary) return fallback;
  // NewsData first (real publisher images), Tavily fills to HEALTH_TARGET. requireImage keeps every
  // card complete; dedup drops any overlap. Provenance stays NewsData's (the primary source).
  const merged = finalizeArticles([...primary.articles, ...fallback.articles], {
    max: HEALTH_TARGET,
    requireImage: true,
  });
  return { articles: merged, provenance: primary.provenance };
}