// Hook tests — the Discover feed hooks (Academic + Health) over TanStack Query.
// (Archetype: data hook.) Proves success / error / market-keying via the fetch mock.
import { describe, expect, test } from "bun:test";

import { mockFetch, renderHookWithProviders, waitFor } from "@tests/helpers/utils";
import { useAcademicDiscover, useHealthDiscover } from "@/hooks/use-discover";
import type { DiscoverArticle } from "@/lib/discover-api";

const prov = { source: "OpenAlex", commercialOk: true, attribution: "Data: OpenAlex" };

const article = (over: Partial<DiscoverArticle> = {}): DiscoverArticle => ({
  id: "w1",
  title: "Untitled paper",
  source: "OpenAlex",
  url: "https://example.org/w1",
  image: null,
  publishedAt: "2026-06-01",
  category: "Research",
  ...over,
});

describe("use-discover", () => {
  describe("useAcademicDiscover", () => {
    test("resolves to the /discover/academic payload", async () => {
      mockFetch({
        "/discover/academic": {
          json: { articles: [article({ id: "a1", title: "On Transformers" })], provenance: prov },
        },
      });
      const { result } = renderHookWithProviders(() => useAcademicDiscover());
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.articles[0]?.title).toBe("On Transformers");
      expect(result.current.data?.provenance.source).toBe("OpenAlex");
    });

    test("surfaces isError on 500", async () => {
      mockFetch({ "/discover/academic": { status: 500 } });
      const { result } = renderHookWithProviders(() => useAcademicDiscover());
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    test("defaults to the US feed (no ?market query)", async () => {
      const { calls } = mockFetch({ "/discover/academic": { json: { articles: [], provenance: prov } } });
      const { result } = renderHookWithProviders(() => useAcademicDiscover());
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(calls.some((c) => c.pathname === "/discover/academic" && c.url.search === "")).toBe(true);
    });

    test("keys the request to /discover/academic by market=in", async () => {
      const { calls } = mockFetch({ "/discover/academic": { json: { articles: [], provenance: prov } } });
      const { result } = renderHookWithProviders(() => useAcademicDiscover("in"));
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(
        calls.some((c) => c.pathname === "/discover/academic" && c.url.search === "?market=in"),
      ).toBe(true);
      // it must NOT hit the health endpoint
      expect(calls.some((c) => c.pathname === "/discover/health")).toBe(false);
    });
  });

  describe("useHealthDiscover", () => {
    test("resolves to the /discover/health payload", async () => {
      mockFetch({
        "/discover/health": {
          json: {
            articles: [article({ id: "h1", title: "Sleep & immunity", source: "WHO", category: "Health" })],
            provenance: { source: "NewsData.io", commercialOk: false, attribution: "Headlines via NewsData.io" },
          },
        },
      });
      const { result } = renderHookWithProviders(() => useHealthDiscover());
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.articles[0]?.title).toBe("Sleep & immunity");
      expect(result.current.data?.provenance.commercialOk).toBe(false);
    });

    test("surfaces isError on 500", async () => {
      mockFetch({ "/discover/health": { status: 500 } });
      const { result } = renderHookWithProviders(() => useHealthDiscover());
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    test("defaults to the US feed (no ?market query)", async () => {
      const { calls } = mockFetch({ "/discover/health": { json: { articles: [], provenance: prov } } });
      const { result } = renderHookWithProviders(() => useHealthDiscover());
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(calls.some((c) => c.pathname === "/discover/health" && c.url.search === "")).toBe(true);
    });

    test("keys the request to /discover/health by market=in", async () => {
      const { calls } = mockFetch({ "/discover/health": { json: { articles: [], provenance: prov } } });
      const { result } = renderHookWithProviders(() => useHealthDiscover("in"));
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(
        calls.some((c) => c.pathname === "/discover/health" && c.url.search === "?market=in"),
      ).toBe(true);
      // it must NOT hit the academic endpoint
      expect(calls.some((c) => c.pathname === "/discover/academic")).toBe(false);
    });
  });
});
