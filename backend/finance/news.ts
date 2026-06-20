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

import { tavily } from "@tavily/core";

import type { Market, Provenance } from "./sources.js";

const FINNHUB_NEWS = "https://finnhub.io/api/v1/news";
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// Indian financial publishers — scope the Tavily India fallback to these (Finnhub's general feed
// is US/global). Headlines link OUT to the publisher; we never display their body text.
const INDIA_NEWS_DOMAINS = [
  "moneycontrol.com",
  "cnbctv18.com",
  "livemint.com",
  "ndtvprofit.com",
  "financialexpress.com",
  "zeebiz.com",
  "business-today.in",
  "economictimes.indiatimes.com",
  "business-standard.com",
];

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

// ── India Discover via NewsData.io (real per-article images) ──────────────
// NewsData.io India business/market news WITH image_url per article — replaces the earlier Tavily
// search, which returned no images (and whose og:image scrape was 403-blocked by most Indian
// publishers). Free tier: 200 credits/day, ~12h delayed — fine behind the 10-min cache. Same legal
// shape as the US cards (headline + source + link + image + timestamp; never the body).
type NewsDataItem = {
  article_id?: string;
  title?: string;
  link?: string;
  image_url?: string | null;
  source_name?: string | null;
  source_id?: string | null;
  pubDate?: string; // "YYYY-MM-DD HH:MM:SS" in UTC (not ISO)
  category?: string[]; // e.g. ["business"]
};
type NewsDataResponse = { status?: string; results?: NewsDataItem[]; message?: string };

const NEWSDATA_LATEST = "https://newsdata.io/api/1/latest";
const MIN_WITH_IMAGE = 6; // keep imageless cards only if fewer than this many have an image

function newsdataKey(): string | null {
  return process.env.NEWSDATA_API_KEY || null;
}

// NewsData pubDate ("YYYY-MM-DD HH:MM:SS" UTC) → ISO; safe fallback to now on a bad/absent value.
function newsdataDateToIso(pubDate: string | undefined): string {
  if (pubDate) {
    const d = new Date(`${pubDate.replace(" ", "T")}Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

async function callNewsData(url: string): Promise<NewsDataResponse> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  const body = (await res.json().catch(() => ({}))) as NewsDataResponse;
  if (!res.ok || body.status === "error") {
    throw new Error(`NewsData ${res.status}: ${body.message ?? "request failed"}`);
  }
  return body;
}

async function fetchDiscoverIndiaNewsData(): Promise<DiscoverPayload> {
  const provenance: Provenance = {
    source: "NewsData.io",
    commercialOk: false,
    attribution: "India market news via NewsData.io — headlines link to publishers",
  };
  const key = newsdataKey();
  if (!key) return { articles: [], provenance, needsKey: true };

  const enc = encodeURIComponent;
  // image=1 → only articles that HAVE an image (the core fix); removeduplicate=1 → server dedup.
  const baseUrl = `${NEWSDATA_LATEST}?apikey=${enc(key)}&language=en&image=1&removeduplicate=1`;
  const filteredUrl = `${baseUrl}&country=in&category=business&q=${enc("stock market NIFTY Sensex")}`;
  const keywordUrl = `${baseUrl}&q=${enc("India stock market NIFTY Sensex")}`;

  // country/category are documented free-tier filters, but some keys gate them → on any error,
  // retry with a pure keyword query (no plan-gated params).
  let data: NewsDataResponse;
  try {
    data = await callNewsData(filteredUrl);
  } catch (e) {
    console.warn("[finance] NewsData filtered query failed, retrying keyword-only:", e instanceof Error ? e.message : e);
    data = await callNewsData(keywordUrl);
  }

  const seen = new Set<string>();
  const mapped: DiscoverArticle[] = [];
  for (const it of data.results ?? []) {
    if (!it.link || !it.title) continue;
    const id = it.article_id || canonicalUrl(String(it.link));
    if (seen.has(id)) continue; // belt-and-suspenders on top of removeduplicate=1
    seen.add(id);
    mapped.push({
      id,
      title: String(it.title),
      source: it.source_name || it.source_id || "",
      url: String(it.link), // NewsData field is `link`, not `url`
      image: it.image_url ?? null, // field is `image_url`, not `image`
      publishedAt: newsdataDateToIso(it.pubDate),
      category: it.category?.[0] ?? "business", // `category` is an array
    });
    if (mapped.length >= MAX_ARTICLES) break;
  }

  // Prefer cards with images, but don't starve the carousel — drop imageless ones only if enough remain.
  const withImage = mapped.filter((a) => a.image);
  return { articles: withImage.length >= MIN_WITH_IMAGE ? withImage : mapped, provenance };
}

// Tavily returns no per-article image, so we hotlink each publisher's OWN og:image thumbnail
// (the standard Google-News / Perplexity card model — hotlinked, never re-hosted). A browser
// User-Agent gets past most publishers; the few that 403 (e.g. Business Standard) keep a clean
// placeholder. Reads only the <head>-ish HTML and is bounded by a short timeout.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const html = await r.text();
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    const img = m?.[1]?.trim();
    return img && img.startsWith("http") ? img : null;
  } catch {
    return null;
  }
}

// Fallback (and the original working source): Tavily news search scoped to Indian publishers.
// Uses the TAVILY_API_KEY we already have, so India Discover ALWAYS works even without a NewsData
// key. We then enrich each card with the publisher's og:image thumbnail (see fetchOgImage).
async function fetchDiscoverIndiaTavily(): Promise<DiscoverPayload> {
  const provenance: Provenance = {
    source: "Tavily (India news)",
    commercialOk: false,
    attribution: "India market news via Tavily — headlines link to publishers",
  };
  const search = await tvly.search(
    "India stock market news today: NIFTY 50, Sensex, Nifty Bank, RBI, rupee — top NSE and BSE market-moving stories",
    { topic: "news", days: 7, maxResults: 25, searchDepth: "basic", includeDomains: INDIA_NEWS_DOMAINS },
  );
  const results = search.results ?? [];
  const seen = new Set<string>();
  const articles: DiscoverArticle[] = [];
  for (const r of results) {
    if (!r.url || !r.title) continue;
    const urlKey = canonicalUrl(String(r.url));
    const titleKey = String(r.title).toLowerCase().trim();
    if (seen.has(urlKey) || seen.has(titleKey)) continue; // dedup by URL + exact title
    seen.add(urlKey);
    seen.add(titleKey);
    let host = "";
    try {
      host = new URL(String(r.url)).hostname.replace(/^www\./, "");
    } catch {
      /* keep host empty */
    }
    const rawDate =
      (r as Record<string, unknown>).publishedDate ?? (r as Record<string, unknown>).published_date;
    const d = rawDate ? new Date(String(rawDate)) : null;
    articles.push({
      id: urlKey,
      title: String(r.title),
      source: host,
      url: String(r.url),
      image: null, // Tavily returns no article hero image → the card shows a clean placeholder
      publishedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString(),
      category: "general",
      // r.content (publisher snippet) intentionally NOT included — never displayed.
    });
    if (articles.length >= MAX_ARTICLES) break;
  }
  // Hotlink each publisher's og:image in parallel (browser UA; blockers keep a clean placeholder).
  const ogImages = await Promise.all(articles.map((a) => fetchOgImage(a.url)));
  articles.forEach((a, i) => {
    a.image = ogImages[i] ?? null;
  });
  // Show cards that have an image first, so the visible page of the carousel looks rich.
  articles.sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));
  return { articles, provenance };
}

// India Discover orchestrator: prefer NewsData.io (real per-article images) WHEN its key is set;
// otherwise — or if it errors / returns nothing — fall back to the Tavily search so the carousel
// always has Indian news. This restores the working feed without requiring a NewsData key.
async function fetchDiscoverIndia(): Promise<DiscoverPayload> {
  if (newsdataKey()) {
    try {
      const nd = await fetchDiscoverIndiaNewsData();
      if (nd.articles.length > 0) return nd;
    } catch (e) {
      console.warn(
        "[finance] NewsData India discover failed, falling back to Tavily:",
        e instanceof Error ? e.message : e,
      );
    }
  }
  return fetchDiscoverIndiaTavily();
}

export async function fetchDiscover(market: Market = "us"): Promise<DiscoverPayload> {
  if (market === "in") return fetchDiscoverIndia();
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
