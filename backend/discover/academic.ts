// ─────────────────────────────────────────────────────────────────────────
// Academic Discover — "latest research" cards from OpenAlex.
//
// WHY OpenAlex: all OpenAlex data is CC0 (public domain), so unlike news publishers we may
// legally display the title (and could show abstracts) commercially with no licence — the
// cleanest source of all (commercialOk:true). Global by topic; India via the country_code
// facet. No API key needed (an optional OPENALEX_MAILTO enters the faster "polite pool").
//
// Card shape is the SAME DiscoverArticle the finance/health feeds use: title + source(venue)
// + outbound link (DOI / landing page) + timestamp. Papers have no hero image, so the card
// falls back to its placeholder/favicon exactly like the imageless finance India cards.
//
// (Next lanes, not in v1: arXiv preprint freshness, Phys.org commercial-OK science NEWS RSS.)
// ─────────────────────────────────────────────────────────────────────────

import { type DiscoverArticle, type DiscoverPayload, type Market, type Provenance, finalizeArticles, toIso } from "./shared.js";

const OPENALEX_WORKS = "https://api.openalex.org/works";
const LOOKBACK_DAYS = 21; // surface papers from roughly the last three weeks, newest first

function openalexMailto(): string | null {
  return process.env.OPENALEX_MAILTO || null;
}

// Minimal shape of the OpenAlex /works result fields we read.
type OAWork = {
  id?: string | null;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_date?: string | null; // "YYYY-MM-DD"
  primary_location?: {
    landing_page_url?: string | null;
    source?: { display_name?: string | null } | null;
  } | null;
  // OpenAlex topic hierarchy: domain > field > subfield > topic. We group cards by the broad
  // FIELD (e.g. "Medicine", "Computer Science", "Environmental Science", "Social Sciences").
  primary_topic?: {
    display_name?: string | null;
    field?: { display_name?: string | null } | null;
  } | null;
};

export async function fetchAcademicDiscover(market: Market = "us"): Promise<DiscoverPayload> {
  const provenance: Provenance = {
    source: "OpenAlex",
    commercialOk: true, // OpenAlex data is CC0 — free to display, attribution courtesy only
    attribution:
      market === "in"
        ? "Latest India-affiliated research via OpenAlex (CC0) — cards link to the paper / DOI"
        : "Latest research via OpenAlex (CC0) — cards link to the paper / DOI",
  };

  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const filters = [
    `from_publication_date:${since}`,
    `to_publication_date:${today}`, // EXCLUDE junk future-dated records (OpenAlex has 2050-… rows)
    "type:article",
    "has_doi:true", // a DOI gives every card a clean, stable outbound link
    "primary_location.source.type:journal", // real peer-reviewed journals, not preprint repos
  ];
  if (market === "in") filters.push("authorships.institutions.country_code:in");

  const params = new URLSearchParams({
    filter: filters.join(","),
    sort: "publication_date:desc", // newest first → a real "latest research" feed
    per_page: "40",
  });
  const mailto = openalexMailto();
  if (mailto) params.set("mailto", mailto);

  const res = await fetch(`${OPENALEX_WORKS}?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": mailto ? `perplexity-webapp (${mailto})` : "perplexity-webapp",
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = (await res.json()) as { results?: OAWork[] };

  const articles: DiscoverArticle[] = [];
  for (const w of data.results ?? []) {
    // Some OpenAlex titles carry JATS markup (e.g. <scp>…</scp>, <i>…</i>) — strip the tags.
    const title = (w.title ?? w.display_name ?? "").replace(/<[^>]+>/g, "").trim();
    // Prefer the DOI (stable, resolvable), then the publisher landing page, then the OpenAlex id.
    const url = w.doi || w.primary_location?.landing_page_url || w.id || "";
    if (!title || !url) continue;
    articles.push({
      id: w.id || url,
      title,
      source: w.primary_location?.source?.display_name || "OpenAlex",
      url,
      image: null, // papers have no hero image → card shows a clean placeholder
      publishedAt: toIso(w.publication_date),
      // Broad field (Medicine / Computer Science / …) so the UI can group papers by category.
      category: w.primary_topic?.field?.display_name || w.primary_topic?.display_name || "Research",
    });
  }

  return { articles: finalizeArticles(articles), provenance };
}
