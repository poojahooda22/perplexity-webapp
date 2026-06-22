// Tests for <AcademicView/> — Lumina's Academic home (topic-discover-view.tsx).
//
// IMPORTANT — what this component actually is: AcademicView is a STATIC, prop-driven view, NOT a
// fetch-driven feed. It does not call /discover/academic, useAcademicDiscover, or render papers
// from a DiscoverPayload — those would surface in a future paper-card UI. Today it renders a search
// box plus two carousels of hardcoded browse categories ("Trending Topics", "Research Papers"),
// and every interaction fires a generated query through the onAsk callback (papers are browsed by
// category, not dumped as a flat list). So there are no loading/empty/error fetch states and no
// DOI/citation links to assert here. We therefore test the real contract: the static cards render
// and each interaction forwards the correct query to onAsk. No finance/health/citation numbers are
// fabricated — every asserted string is the component's own static copy.
import { describe, expect, test, mock } from "bun:test";

import { renderWithProviders, screen, fireEvent, within } from "@tests/helpers/utils";
import { AcademicView } from "@/components/discover/topic-discover-view";

const YEAR = new Date().getFullYear();

describe("AcademicView", () => {
  test("renders the Lumina-branded title and both category sections", () => {
    renderWithProviders(<AcademicView onAsk={mock()} />);

    // Brand rule: the visible product name is "lumina" (never "Perplexity").
    expect(screen.getByText("lumina")).toBeInTheDocument();
    expect(screen.getByText("academic")).toBeInTheDocument();
    expect(screen.queryByText(/perplexity/i)).toBeNull();

    expect(screen.getByRole("heading", { name: "Trending Topics" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Research Papers" })).toBeInTheDocument();
  });

  test("renders the search box with its placeholder and a disabled submit until text is typed", () => {
    renderWithProviders(<AcademicView onAsk={mock()} />);

    const box = screen.getByPlaceholderText("Explore academic papers, journals, and more");
    expect(box).toBeInTheDocument();

    // The send button is disabled while the box is empty, enabled once it has non-whitespace text.
    const submit = screen.getByRole("button", { name: "Search" });
    expect(submit).toBeDisabled();

    fireEvent.change(box, { target: { value: "transformer architectures" } });
    expect(submit).not.toBeDisabled();
  });

  test("submitting the form forwards the trimmed query to onAsk and clears the box", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    const box = screen.getByPlaceholderText("Explore academic papers, journals, and more") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  CRISPR gene editing  " } });
    fireEvent.submit(box.closest("form")!);

    expect(onAsk).toHaveBeenCalledTimes(1);
    // Trimmed query, empty attachments array (the second onAsk arg).
    expect(onAsk).toHaveBeenCalledWith("CRISPR gene editing", []);
    // Box resets after a successful submit.
    expect(box.value).toBe("");
  });

  test("pressing Enter (without Shift) submits the query to onAsk", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    const box = screen.getByPlaceholderText("Explore academic papers, journals, and more");
    fireEvent.change(box, { target: { value: "quantum error correction" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: false });

    expect(onAsk).toHaveBeenCalledWith("quantum error correction", []);
  });

  test("Shift+Enter does NOT submit (newline in the textarea)", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    const box = screen.getByPlaceholderText("Explore academic papers, journals, and more");
    fireEvent.change(box, { target: { value: "multi-line draft" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

    expect(onAsk).not.toHaveBeenCalled();
  });

  test("an empty / whitespace-only query is not forwarded to onAsk", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    const box = screen.getByPlaceholderText("Explore academic papers, journals, and more");
    // Whitespace only — submit guard (q.trim()) should drop it.
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: false });

    expect(onAsk).not.toHaveBeenCalled();
  });

  test("clicking a quick-category chip asks a generated research query for that topic", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    // CHIPS = ["Health", "Law", "Technology", "Science", "Humanities"].
    fireEvent.click(screen.getByRole("button", { name: "Science" }));

    expect(onAsk).toHaveBeenCalledTimes(1);
    const [query, attachments] = onAsk.mock.calls[0];
    expect(query).toBe(`Latest science research breakthroughs and notable papers in ${YEAR}`);
    expect(attachments).toEqual([]);
  });

  test("renders the static Trending Topics cards and clicking one asks about that area's trends", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    // The first carousel page (perPage=3) shows the first three TRENDING categories.
    const trendingCard = screen.getByText("Technology and computer science");
    expect(trendingCard).toBeInTheDocument();

    fireEvent.click(trendingCard);
    expect(onAsk).toHaveBeenCalledWith(
      `What are the latest research trends in technology and computer science in ${YEAR}?`,
      [],
    );
  });

  test("renders Research Papers browse cards and clicking one asks for that area's latest papers with links", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    // "Artificial Intelligence" is the first RESEARCH category (visible on page 1).
    const aiCard = screen.getByText("Artificial Intelligence");
    expect(aiCard).toBeInTheDocument();

    fireEvent.click(aiCard);
    expect(onAsk).toHaveBeenCalledWith(
      `Show the latest research papers and key findings in Artificial Intelligence (${YEAR}), with links.`,
      [],
    );
  });

  test("the Trending carousel paginates to reveal categories that were off the first page", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    // Scope to the Trending Topics section so we drive its own Next button (Research has one too).
    const trendingHeading = screen.getByRole("heading", { name: "Trending Topics" });
    const trendingSection = trendingHeading.closest("section")!;
    const trending = within(trendingSection);

    // Page 1 (perPage=3) shows the first three; "Natural sciences" is on page 2.
    expect(trending.queryByText("Natural sciences")).toBeNull();
    expect(trending.getByText("Technology and computer science")).toBeInTheDocument();

    fireEvent.click(trending.getByRole("button", { name: "Next" }));

    // Page 2 now reveals the later categories and hides the first-page ones.
    expect(trending.getByText("Natural sciences")).toBeInTheDocument();
    expect(trending.queryByText("Technology and computer science")).toBeNull();
  });

  test("does not call onAsk on initial render (no implicit/auto query)", () => {
    const onAsk = mock();
    renderWithProviders(<AcademicView onAsk={onAsk} />);

    expect(onAsk).not.toHaveBeenCalled();
  });
});
