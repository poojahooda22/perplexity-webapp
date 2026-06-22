// Integration tests for the Health surface through <HealthView/>. We drive the real fetch router
// (overriding /discover/health per edge case) and exercise: the Discover news carousel
// (loading / empty / error / success), the guided "Health Workflows" cards, the search/ask box,
// the lab-report upload control, and the medical-safety framing (guidance, not diagnosis).
import { describe, expect, test, mock } from "bun:test";

import { mockFetch, renderWithProviders, screen, fireEvent, waitFor, type Routes } from "@tests/helpers/utils";
import { HealthView } from "@/components/discover/health-view";

const prov = { source: "NewsData", commercialOk: false, attribution: "Latest health news · NewsData" };
const PAST = "2026-06-22T00:00:00Z";

// A health article in OUR fixture shape — we assert HealthView renders this, never a real headline.
const ARTICLE = {
  id: "h1",
  title: "New guidance on daily sleep duration",
  source: "Test Health Wire",
  url: "https://example.test/sleep",
  image: null,
  publishedAt: PAST,
  category: "health",
};

// Default happy-path router. Spread overrides on top to reach an edge branch.
function healthRoutes(overrides: Routes = {}): Routes {
  return {
    "/discover/health": { json: { articles: [ARTICLE], provenance: prov } },
    ...(overrides as Record<string, unknown>),
  } as Routes;
}

describe("HealthView", () => {
  test("renders the Lumina Health header and the ask box (brand: never 'Perplexity')", async () => {
    mockFetch(healthRoutes());
    renderWithProviders(<HealthView onAsk={() => {}} />);

    expect(screen.getByRole("heading", { name: "Lumina Health" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask anything about health…")).toBeInTheDocument();
    expect(screen.queryByText(/Perplexity/i)).toBeNull();
  });

  test("shows the loading state, then the success news card from our fixture", async () => {
    mockFetch(healthRoutes());
    renderWithProviders(<HealthView onAsk={() => {}} />);

    // Loading appears immediately while the query is in flight.
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    // Then the article from OUR mock renders.
    expect(await screen.findByText(ARTICLE.title)).toBeInTheDocument();
    expect(screen.getByText(ARTICLE.source)).toBeInTheDocument();
    // The article links out to its source (headline + link-out only).
    const link = screen.getByRole("link", { name: /daily sleep duration/i });
    expect(link).toHaveAttribute("href", ARTICLE.url);
  });

  test("uses the provenance attribution as the Discover subtitle when present", async () => {
    mockFetch(healthRoutes());
    renderWithProviders(<HealthView onAsk={() => {}} />);

    expect(await screen.findByText(prov.attribution)).toBeInTheDocument();
  });

  test("shows the empty state when the feed returns no articles", async () => {
    mockFetch(healthRoutes({ "/discover/health": { json: { articles: [], provenance: prov } } }));
    renderWithProviders(<HealthView onAsk={() => {}} />);

    expect(await screen.findByText(/No health news right now/i)).toBeInTheDocument();
  });

  test("shows the error state when the feed request fails", async () => {
    mockFetch(healthRoutes({ "/discover/health": { status: 500 } }));
    renderWithProviders(<HealthView onAsk={() => {}} />);

    expect(await screen.findByText(/Couldn.t load/i)).toBeInTheDocument();
  });

  test("switching to India refetches /discover/health with ?market=in", async () => {
    const { calls } = mockFetch(healthRoutes());
    renderWithProviders(<HealthView onAsk={() => {}} />);

    // Wait for the initial (US) fetch.
    await screen.findByText(ARTICLE.title);
    expect(calls.some((c) => c.pathname === "/discover/health" && c.url.search === "")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "India" }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.pathname === "/discover/health" && c.url.search === "?market=in"),
      ).toBe(true),
    );
  });

  test("renders the guided Health Workflows and explains they start a focused chat", async () => {
    mockFetch(healthRoutes());
    renderWithProviders(<HealthView onAsk={() => {}} />);

    expect(screen.getByRole("heading", { name: "Health Workflows" })).toBeInTheDocument();
    expect(screen.getByText(/pick one to start a focused chat/i)).toBeInTheDocument();
    // A sample of the workflow cards.
    expect(screen.getByText("Health review")).toBeInTheDocument();
    expect(screen.getByText("Nutrition planner")).toBeInTheDocument();
    expect(screen.getByText("Lab results interpreter")).toBeInTheDocument();
    expect(screen.getByText("Fitness coach")).toBeInTheDocument();
  });

  test("clicking a workflow card forwards its prompt to onAsk with no attachments", async () => {
    mockFetch(healthRoutes());
    const onAsk = mock(() => {});
    renderWithProviders(<HealthView onAsk={onAsk} />);

    fireEvent.click(screen.getByText("Nutrition planner"));

    expect(onAsk).toHaveBeenCalledTimes(1);
    const [query, attachments] = onAsk.mock.calls[0];
    expect(query).toMatch(/nutrition planner/i);
    expect(attachments).toEqual([]);
  });

  test("typing a question and submitting the form calls onAsk and clears the box", async () => {
    mockFetch(healthRoutes());
    const onAsk = mock(() => {});
    renderWithProviders(<HealthView onAsk={onAsk} />);

    const box = screen.getByPlaceholderText("Ask anything about health…") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Is intermittent fasting safe?" } });
    fireEvent.submit(box.closest("form")!);

    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk.mock.calls[0][0]).toBe("Is intermittent fasting safe?");
    expect(onAsk.mock.calls[0][1]).toEqual([]);
    expect(box.value).toBe("");
  });

  test("pressing Enter (without Shift) submits the question via onAsk", async () => {
    mockFetch(healthRoutes());
    const onAsk = mock(() => {});
    renderWithProviders(<HealthView onAsk={onAsk} />);

    const box = screen.getByPlaceholderText("Ask anything about health…") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "What raises blood pressure?" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: false });

    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk.mock.calls[0][0]).toBe("What raises blood pressure?");
  });

  test("an empty/whitespace question does not call onAsk", async () => {
    mockFetch(healthRoutes());
    const onAsk = mock(() => {});
    renderWithProviders(<HealthView onAsk={onAsk} />);

    const box = screen.getByPlaceholderText("Ask anything about health…");
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.submit(box.closest("form")!);

    expect(onAsk).not.toHaveBeenCalled();
  });

  test("the Ask submit button is disabled until the box has text", async () => {
    mockFetch(healthRoutes());
    renderWithProviders(<HealthView onAsk={() => {}} />);

    const submit = screen.getByRole("button", { name: "Ask" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Ask anything about health…"), {
      target: { value: "headache causes" },
    });
    expect(submit).not.toBeDisabled();
  });

  test("exposes the lab-report upload control with a doctor-safety note", async () => {
    mockFetch(healthRoutes());
    renderWithProviders(<HealthView onAsk={() => {}} />);

    expect(screen.getByRole("heading", { name: "Health files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload lab results & documents/i })).toBeInTheDocument();
    // Medical-safety framing: a hand-off to a doctor, not a diagnosis.
    expect(screen.getByText(/flag anything to discuss with a doctor/i)).toBeInTheDocument();
  });

  test("uploading a lab report sends a summarize prompt + the file attachment to onAsk", async () => {
    mockFetch(healthRoutes());
    const onAsk = mock(() => {});
    const { container } = renderWithProviders(<HealthView onAsk={onAsk} />);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const file = new File(["alt: 42 U/L\nldl: 130 mg/dL"], "labs.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(onAsk).toHaveBeenCalledTimes(1));
    const [query, attachments] = onAsk.mock.calls[0];
    // The prompt is informational (summarize + flag for a doctor) — not a diagnosis/treatment.
    expect(query).toMatch(/Summarize this health report/i);
    expect(query).toMatch(/discuss with a doctor/i);
    // The attachment is our uploaded file, encoded to the base64 Attachment shape.
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "labs.txt", mediaType: "text/plain" });
    expect(typeof attachments[0].base64).toBe("string");
  });
});
