// Unit/component tests for the shared Discover primitives (Academic + Health pages reuse these):
// the pure helpers (timeAgo / faviconFromUrl / wiki), the arrows+dots <Carousel/>, the image
// <CategoryCard/>, and the news <ArticleCard/>. These are prop-driven — no fetch happens here, so
// we render with explicit props and assert the component renders OUR data, link targets are correct,
// and the onError image-hide branch fires.
import { describe, expect, test } from "bun:test";

import { renderWithProviders, screen, fireEvent, within } from "@tests/helpers/utils";
import {
  timeAgo,
  faviconFromUrl,
  wiki,
  Carousel,
  CategoryCard,
  ArticleCard,
  type Category,
} from "@/components/discover/discover-parts";
import type { DiscoverArticle } from "@/lib/discover-api";

// A stable article factory so we never assert fabricated "real" data — only what we pass in.
function makeArticle(overrides: Partial<DiscoverArticle> = {}): DiscoverArticle {
  return {
    id: "a1",
    title: "Breakthrough in sleep science",
    source: "Nature",
    url: "https://www.nature.com/articles/xyz",
    image: "https://cdn.example.com/cover.jpg",
    publishedAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min ago
    category: "research",
    ...overrides,
  };
}

describe("timeAgo", () => {
  test('returns "just now" for under a minute', () => {
    expect(timeAgo(new Date(Date.now() - 10_000).toISOString())).toBe("just now");
  });

  test('clamps future timestamps to "just now" (never negative)', () => {
    expect(timeAgo(new Date(Date.now() + 60_000).toISOString())).toBe("just now");
  });

  test("formats minutes, hours, and days", () => {
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 min ago");
    expect(timeAgo(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3h ago");
    expect(timeAgo(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("2d ago");
  });
});

describe("faviconFromUrl", () => {
  test("builds a Google favicon URL from the hostname", () => {
    const fav = faviconFromUrl("https://www.nature.com/articles/xyz");
    expect(fav).toBe("https://www.google.com/s2/favicons?domain=www.nature.com&sz=64");
  });

  test("returns an empty string for an unparseable URL", () => {
    expect(faviconFromUrl("not a url")).toBe("");
  });
});

describe("wiki", () => {
  test("builds a Wikimedia Special:FilePath URL with width", () => {
    expect(wiki("Mona_Lisa.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Mona_Lisa.jpg?width=1000",
    );
  });
});

describe("Carousel", () => {
  const items = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  const renderItem = (label: string) => <div key={label}>{label}</div>;

  test("renders only the first page worth of items when items exceed perPage", () => {
    renderWithProviders(<Carousel items={items} perPage={2} render={renderItem} />);
    // page 1 → first two items visible, the rest not
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
  });

  test("shows pagination controls (prev/next + a dot per page) when there is more than one page", () => {
    renderWithProviders(<Carousel items={items} perPage={2} render={renderItem} />);
    expect(screen.getByRole("button", { name: "Previous" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    // 5 items / 2 per page → 3 pages → 3 dot buttons
    expect(screen.getByRole("button", { name: "Page 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Page 4" })).not.toBeInTheDocument();
  });

  test("hides pagination entirely when everything fits on one page", () => {
    renderWithProviders(<Carousel items={["Solo"]} perPage={3} render={renderItem} />);
    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Page 1" })).not.toBeInTheDocument();
  });

  test("Next advances to the following page of items", () => {
    renderWithProviders(<Carousel items={items} perPage={2} render={renderItem} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Gamma")).toBeInTheDocument();
    expect(screen.getByText("Delta")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  test("clicking a page dot jumps directly to that page", () => {
    renderWithProviders(<Carousel items={items} perPage={2} render={renderItem} />);
    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    // page 3 of [2,2,1] → the single trailing item
    expect(screen.getByText("Epsilon")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  test("Previous is disabled on the first page; Next on the last page", () => {
    renderWithProviders(<Carousel items={items} perPage={2} render={renderItem} />);
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).not.toBeDisabled();
  });

  test("renders an empty grid (and no controls) when items is empty", () => {
    renderWithProviders(<Carousel items={[] as string[]} perPage={3} render={renderItem} />);
    // Math.max(1, ceil(0/3)) = 1 page → no pagination
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Page 1" })).not.toBeInTheDocument();
  });
});

describe("CategoryCard", () => {
  const item: Category = { label: "Cardiology", image: "https://cdn.example.com/heart.jpg" };

  test("renders the label and the image from props", () => {
    renderWithProviders(<CategoryCard item={item} onClick={() => {}} />);
    expect(screen.getByText("Cardiology")).toBeInTheDocument();
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://cdn.example.com/heart.jpg");
  });

  test("fires onClick when the card is pressed", () => {
    let clicked = 0;
    renderWithProviders(<CategoryCard item={item} onClick={() => (clicked += 1)} />);
    fireEvent.click(screen.getByRole("button", { name: /Cardiology/ }));
    expect(clicked).toBe(1);
  });
});

describe("ArticleCard", () => {
  test("renders title + source and links out in a new tab with rel noopener", () => {
    const a = makeArticle();
    renderWithProviders(<ArticleCard a={a} />);

    const link = screen.getByRole("link", { name: /Breakthrough in sleep science/ });
    expect(link).toHaveAttribute("href", a.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(link).getByText("Nature")).toBeInTheDocument();
    expect(within(link).getByText(/min ago/)).toBeInTheDocument();
  });

  test("renders the cover image when an image URL is present", () => {
    const a = makeArticle({ image: "https://cdn.example.com/cover.jpg" });
    renderWithProviders(<ArticleCard a={a} />);
    const cover = document.querySelector('img[src="https://cdn.example.com/cover.jpg"]');
    expect(cover).not.toBeNull();
  });

  test("omits the cover image block entirely when image is null", () => {
    const a = makeArticle({ image: null });
    renderWithProviders(<ArticleCard a={a} />);
    expect(document.querySelector('img[src="https://cdn.example.com/cover.jpg"]')).toBeNull();
    // the favicon img still renders, so the card is not imageless overall
    expect(screen.getByRole("link", { name: /Breakthrough/ })).toBeInTheDocument();
  });

  test("renders a favicon img derived from the article URL", () => {
    const a = makeArticle();
    renderWithProviders(<ArticleCard a={a} />);
    const fav = document.querySelector(
      'img[src="https://www.google.com/s2/favicons?domain=www.nature.com&sz=64"]',
    );
    expect(fav).not.toBeNull();
  });

  test("a broken cover image hides itself via onError (display:none)", () => {
    const a = makeArticle({ image: "https://cdn.example.com/cover.jpg" });
    renderWithProviders(<ArticleCard a={a} />);
    const cover = document.querySelector(
      'img[src="https://cdn.example.com/cover.jpg"]',
    ) as HTMLImageElement;
    expect(cover).not.toBeNull();
    fireEvent.error(cover);
    expect(cover.style.display).toBe("none");
  });

  test("a broken favicon hides itself via onError (display:none)", () => {
    const a = makeArticle();
    renderWithProviders(<ArticleCard a={a} />);
    const fav = document.querySelector(
      'img[src="https://www.google.com/s2/favicons?domain=www.nature.com&sz=64"]',
    ) as HTMLImageElement;
    expect(fav).not.toBeNull();
    fireEvent.error(fav);
    expect(fav.style.display).toBe("none");
  });
});
