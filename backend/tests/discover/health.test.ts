// Health Discover — the NewsData lane: global India-origin geo-filter, image-only cards, count.
// (Bug fixed here: India-published outlets like "Business News India" used to leak into the GLOBAL
// feed because no country filter was applied; the feed now excludes India-origin from global, keeps
// it for the India feed, drops imageless cards, and serves up to 20.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { fetchHealthNewsData } from "../../discover/health";
import { finalizeArticles, type DiscoverArticle } from "../../discover/shared";
import { mockFetch, type FetchMock } from "../helpers/fetch-mock";

let fm: FetchMock | undefined;
beforeEach(() => {
  process.env.NEWSDATA_API_KEY = "test-newsdata-key";
});
afterEach(() => {
  fm?.restore();
  fm = undefined;
  delete process.env.NEWSDATA_API_KEY;
});

const item = (over: Record<string, unknown> = {}) => ({
  article_id: "x",
  title: "Health headline",
  link: "https://who.int/x",
  image_url: "https://img.example/x.jpg",
  source_name: "WHO",
  country: ["united states of america"],
  category: ["health"],
  pubDate: "2026-06-20 10:00:00",
  ...over,
});

const newsdata = (results: unknown[]) => ({
  "newsdata.io": { json: { status: "success", results } },
});

describe("fetchHealthNewsData — global geo-filter", () => {
  test("drops India-published outlets from the GLOBAL feed (the leak bug)", async () => {
    fm = mockFetch(
      newsdata([
        item({ article_id: "g1", title: "Global vaccine rollout update", link: "https://who.int/a", source_name: "WHO", country: ["united states of america"] }),
        item({
          article_id: "in1",
          title: "Business News India: USFDA turns to India",
          link: "https://businessnewsindia.in/b",
          source_name: "Business News India",
          country: ["india"],
        }),
        item({ article_id: "g2", title: "WHO outbreak alert issued", link: "https://cdc.gov/c", source_name: "CDC", country: ["united kingdom"] }),
      ]),
    );
    const r = await fetchHealthNewsData("us");
    const urls = r.articles.map((a) => a.url);
    expect(urls).toContain("https://who.int/a");
    expect(urls).toContain("https://cdc.gov/c");
    expect(urls.some((u) => u.includes("businessnewsindia"))).toBe(false);
    expect(r.articles.some((a) => a.source === "Business News India")).toBe(false);
  });

  test("the INDIA feed keeps India-origin outlets", async () => {
    fm = mockFetch(
      newsdata([
        item({ article_id: "in1", title: "ICMR vaccine update", link: "https://thehindu.com/a", source_name: "The Hindu", country: ["india"] }),
        item({ article_id: "in2", title: "AIIMS hospital expansion", link: "https://ndtv.com/b", source_name: "NDTV", country: ["india"] }),
      ]),
    );
    const r = await fetchHealthNewsData("in");
    expect(r.articles).toHaveLength(2);
    expect(r.articles.some((a) => a.source === "The Hindu")).toBe(true);
  });
});

describe("fetchHealthNewsData — images + count", () => {
  test("drops articles that have no image (no blank cards)", async () => {
    fm = mockFetch(
      newsdata([
        item({ article_id: "i1", link: "https://who.int/withimg", image_url: "https://img.example/1.jpg" }),
        item({ article_id: "i2", link: "https://who.int/noimg", image_url: null }),
      ]),
    );
    const r = await fetchHealthNewsData("us");
    expect(r.articles).toHaveLength(1);
    expect(r.articles[0]!.url).toBe("https://who.int/withimg");
  });

  test("serves up to 20 cards (not 18)", async () => {
    const results = Array.from({ length: 25 }, (_, i) =>
      item({ article_id: `a${i}`, title: `Health story ${i}`, link: `https://who.int/a${i}` }),
    );
    fm = mockFetch(newsdata(results));
    const r = await fetchHealthNewsData("us");
    expect(r.articles).toHaveLength(20);
  });

  test("maps NewsData fields onto the card shape", async () => {
    fm = mockFetch(newsdata([item({ article_id: "m1", source_name: "STAT News", category: ["health"] })]));
    const r = await fetchHealthNewsData("us");
    expect(r.articles[0]).toMatchObject({ source: "STAT News", category: "health", image: "https://img.example/x.jpg" });
    expect(r.provenance.commercialOk).toBe(false); // publisher headlines are not display-licensed
  });
});

describe("finalizeArticles options", () => {
  const arts: DiscoverArticle[] = [
    { id: "1", title: "A", source: "a.com", url: "https://a.com", image: "https://i/a.jpg", publishedAt: "2026-06-20T00:00:00Z", category: "health" },
    { id: "2", title: "B", source: "b.com", url: "https://b.com", image: null, publishedAt: "2026-06-20T00:00:00Z", category: "health" },
  ];

  test("requireImage drops imageless cards; default keeps them", () => {
    expect(finalizeArticles(arts, { requireImage: true })).toHaveLength(1);
    expect(finalizeArticles(arts)).toHaveLength(2); // backward-compatible default
  });

  test("max caps the count", () => {
    expect(finalizeArticles(arts, { max: 1 })).toHaveLength(1);
  });
});