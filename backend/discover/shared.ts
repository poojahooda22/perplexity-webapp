// ─────────────────────────────────────────────────────────────────────────
// Shared building blocks for the "Discover" card feeds (health / academic — and a pattern
// the finance Discover can migrate onto later). Every vertical uses the SAME card shape and
// the SAME legal ship-rule: expose ONLY headline + source + outbound link + (hotlinked, never
// re-hosted) image + timestamp. A publisher's body/snippet/abstract is NEVER included here
// unless the source's licence explicitly allows it (handled per-source in the vertical files).
// ─────────────────────────────────────────────────────────────────────────

export type Market = "us" | "in";

// Mirrors the finance Provenance shape so the frontend renders every Discover surface the same.
export type Provenance = { source: string; commercialOk: boolean; attribution: string };

export type DiscoverArticle = {
  id: string;
  title: string;
  source: string;
  url: string;
  image: string | null;
  publishedAt: string; // ISO
  category: string;
};

export type DiscoverPayload = { articles: DiscoverArticle[]; provenance: Provenance; needsKey?: boolean };

export const MAX_ARTICLES = 18;
export const MIN_WITH_IMAGE = 6; // keep imageless cards only if fewer than this many have an image

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Canonicalize a URL for dedup: lowercase host, strip tracking params + hash + trailing slash.
export function canonicalUrl(u: string): string {
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

// The hostname (without www.) — used as a fallback "source" label when none is given.
export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Hotlink a page's OWN og:image thumbnail (browser UA; blockers → null = clean placeholder).
// Reads only enough HTML to find the meta tag and is bounded by a short timeout.
export async function fetchOgImage(url: string): Promise<string | null> {
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

// A safe ISO string from a loose date input (epoch seconds, ms, ISO, "YYYY-MM-DD"…) — falls
// back to "now" on anything unparseable so a card never shows an invalid date.
export function toIso(input: unknown): string {
  if (typeof input === "number") {
    const ms = input > 1e12 ? input : input * 1000; // seconds vs ms
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof input === "string" && input.trim()) {
    const norm = /^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00Z` : input;
    const d = new Date(norm);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

// Dedup (by canonical URL + exact lowercased title), drop title/url-less items, cap at `max`,
// and sort image-bearing cards first so the visible carousel page looks rich. Pass
// `requireImage: true` to keep ONLY cards that carry an image (no blank tiles in the feed).
export function finalizeArticles(
  articles: DiscoverArticle[],
  opts: { max?: number; requireImage?: boolean } = {},
): DiscoverArticle[] {
  const max = opts.max ?? MAX_ARTICLES;
  const seen = new Set<string>();
  const out: DiscoverArticle[] = [];
  for (const a of articles) {
    if (!a.url || !a.title) continue;
    if (opts.requireImage && !(a.image && a.image.trim())) continue; // image-complete cards only
    const urlKey = canonicalUrl(a.url);
    const titleKey = a.title.toLowerCase().trim();
    if (seen.has(urlKey) || seen.has(titleKey)) continue;
    seen.add(urlKey);
    seen.add(titleKey);
    out.push({ ...a, id: a.id || urlKey });
    if (out.length >= max) break;
  }
  out.sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));
  return out;
}
