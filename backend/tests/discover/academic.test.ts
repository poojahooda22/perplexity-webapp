import { afterEach, describe, expect, test } from "bun:test";

import { fetchAcademicDiscover } from "../../discover/academic";
import { mockFetch, type FetchMock } from "../helpers/fetch-mock";

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
});

describe("fetchAcademicDiscover (OpenAlex)", () => {
  test("maps works, strips JATS markup, prefers the DOI, and is commercialOk (CC0)", async () => {
    fm = mockFetch({
      "api.openalex.org/works": {
        json: {
          results: [
            {
              id: "https://openalex.org/W1",
              doi: "https://doi.org/10.1/x",
              title: "A <i>great</i> <scp>paper</scp>",
              publication_date: "2026-06-01",
              primary_location: { landing_page_url: "https://j/x", source: { display_name: "Nature" } },
              primary_topic: { display_name: "T", field: { display_name: "Medicine" } },
            },
          ],
        },
      },
    });
    const { articles, provenance } = await fetchAcademicDiscover("us");
    expect(provenance.source).toBe("OpenAlex");
    expect(provenance.commercialOk).toBe(true); // CC0 — the one commercial-OK discover source

    const a = articles.find((x) => x.title === "A great paper"); // JATS tags stripped
    expect(a).toBeDefined();
    expect(a!.url).toBe("https://doi.org/10.1/x"); // DOI preferred over landing page
    expect(a!.source).toBe("Nature");
    expect(a!.category).toBe("Medicine"); // grouped by OpenAlex field
  });

  test("throws on a non-OK OpenAlex response", async () => {
    fm = mockFetch({ "api.openalex.org/works": { status: 500 } });
    await expect(fetchAcademicDiscover("us")).rejects.toThrow(/OpenAlex 500/);
  });

  test("India market adds the country_code filter to the query", async () => {
    fm = mockFetch({ "api.openalex.org/works": { json: { results: [] } } });
    await fetchAcademicDiscover("in");
    expect(decodeURIComponent(fm.calls[0]!.url.toString())).toContain(
      "authorships.institutions.country_code:in",
    );
  });
});