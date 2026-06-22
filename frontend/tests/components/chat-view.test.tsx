// Integration tests for <ChatView/> — the streaming chat surface. It is purely prop-driven:
// it never fetches; instead it runs parseStream() over each turn's `full` buffer (the raw wire
// protocol: `<ANSWER>…</ANSWER>` + `<FOLLOW_UPS><question>…</question></FOLLOW_UPS>` then
// `\n<SOURCES>\n[json]\n<SOURCES>\n` then `\n<IMAGES>\n[json]\n<IMAGES>\n`). We build those buffers
// here and assert the answer/links/images tabs render OUR data, plus the follow-up + composer
// interactions and the busy/streaming/error states. (Archetype: prop-driven component.)
import { describe, expect, test, mock } from "bun:test";

import { renderWithProviders, screen, fireEvent, within } from "@tests/helpers/utils";
import { ChatView, type Turn } from "@/components/chat-view";
import type { Source, ImageResult } from "@/lib/api";

// ── Wire-protocol builders ────────────────────────────────────────────────────
function sourcesBlock(sources: Source[]): string {
  return `\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n`;
}
function imagesBlock(images: ImageResult[]): string {
  return `\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`;
}
function followUpsBlock(questions: string[]): string {
  if (questions.length === 0) return "";
  return `<FOLLOW_UPS>${questions.map((q) => `<question>${q}</question>`).join("")}</FOLLOW_UPS>`;
}

/** Assemble a complete "done" wire buffer from parts. */
function buildFull(opts: {
  answer?: string;
  followUps?: string[];
  sources?: Source[];
  images?: ImageResult[];
}): string {
  const answer = `<ANSWER>${opts.answer ?? ""}</ANSWER>`;
  const fu = followUpsBlock(opts.followUps ?? []);
  const src = opts.sources?.length ? sourcesBlock(opts.sources) : "";
  const img = opts.images?.length ? imagesBlock(opts.images) : "";
  return `${answer}${fu}${src}${img}`;
}

const SOURCES: Source[] = [
  { title: "Lumina Source One", url: "https://example.com/one", content: "Snippet for source one." },
  { title: "Lumina Source Two", url: "https://docs.example.org/two", content: "Snippet for source two." },
];

const IMAGES: ImageResult[] = [
  { url: "https://cdn.example.com/pic-a.jpg", description: "Picture A" },
  { url: "https://cdn.example.com/pic-b.jpg", description: "Picture B" },
];

function doneTurn(over: Partial<Turn> = {}, fullOpts: Parameters<typeof buildFull>[0] = {}): Turn {
  return {
    id: "t1",
    question: "What is Lumina?",
    full: buildFull({ answer: "Lumina is a research app.", ...fullOpts }),
    status: "done",
    ...over,
  };
}

describe("ChatView", () => {
  // ── answer tab ──────────────────────────────────────────────────────────────
  test("answer tab renders the parsed question + answer text", () => {
    const turn = doneTurn({}, { answer: "Lumina is a multi-vertical research app." });
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="answer" onFollowUp={mock()} busy={false} />,
    );

    expect(screen.getByText("What is Lumina?")).toBeInTheDocument();
    expect(screen.getByText("Lumina is a multi-vertical research app.")).toBeInTheDocument();
  });

  test("answer tab shows the top source chips with their titles", () => {
    const turn = doneTurn({}, { answer: "Answer body.", sources: SOURCES });
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="answer" onFollowUp={mock()} busy={false} />,
    );

    // Source chips render the source title and link to its url.
    const chip = screen.getByText("Lumina Source One").closest("a");
    expect(chip).toHaveAttribute("href", "https://example.com/one");
    expect(screen.getByText("Lumina Source Two")).toBeInTheDocument();
  });

  test("streaming turn with no answer yet shows the searching spinner", () => {
    const turn: Turn = { id: "s1", question: "loading?", full: "", status: "streaming" };
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="answer" onFollowUp={mock()} busy={true} />,
    );

    expect(screen.getByText(/Searching the web/)).toBeInTheDocument();
  });

  test("error turn renders the error message", () => {
    const turn: Turn = { id: "e1", question: "boom?", full: "", status: "error", error: "Request failed (500)" };
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="answer" onFollowUp={mock()} busy={false} />,
    );

    expect(screen.getByText("Request failed (500)")).toBeInTheDocument();
  });

  test("error turn without a message falls back to the default copy", () => {
    const turn: Turn = { id: "e2", question: "boom?", full: "", status: "error" };
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="answer" onFollowUp={mock()} busy={false} />,
    );

    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
  });

  // ── follow-ups ──────────────────────────────────────────────────────────────
  test("clicking a related follow-up calls onFollowUp with that query", () => {
    const onFollowUp = mock();
    const turn = doneTurn({}, {
      answer: "Body.",
      followUps: ["What verticals does Lumina cover?", "How does Lumina cite sources?"],
    });
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="answer" onFollowUp={onFollowUp} busy={false} />,
    );

    expect(screen.getByText("Related")).toBeInTheDocument();
    fireEvent.click(screen.getByText("What verticals does Lumina cover?"));

    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp.mock.calls[0]?.[0]).toBe("What verticals does Lumina cover?");
  });

  test("follow-ups are hidden while the last turn is still streaming", () => {
    const turn: Turn = {
      id: "s2",
      question: "streaming q",
      full: buildFull({ answer: "partial…", followUps: ["A later follow-up?"] }),
      status: "streaming",
    };
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="answer" onFollowUp={mock()} busy={true} />,
    );

    expect(screen.queryByText("Related")).not.toBeInTheDocument();
    expect(screen.queryByText("A later follow-up?")).not.toBeInTheDocument();
  });

  test("follow-up buttons are disabled while busy", () => {
    const turn = doneTurn({}, { answer: "Body.", followUps: ["Disabled follow-up?"] });
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="answer" onFollowUp={mock()} busy={true} />,
    );

    const btn = screen.getByText("Disabled follow-up?").closest("button");
    expect(btn).toBeDisabled();
  });

  // ── links tab ───────────────────────────────────────────────────────────────
  test("links tab lists every deduped source with its url + query header", () => {
    const turn = doneTurn({ question: "best databases?" }, { answer: "x", sources: SOURCES });
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="links" onFollowUp={mock()} busy={false} />,
    );

    // Query echo header.
    expect(screen.getByText("best databases?")).toBeInTheDocument();
    // Each source url is shown.
    expect(screen.getByText("https://example.com/one")).toBeInTheDocument();
    expect(screen.getByText("https://docs.example.org/two")).toBeInTheDocument();
    // The content snippet is shown.
    expect(screen.getByText("Snippet for source one.")).toBeInTheDocument();
  });

  test("links tab dedupes sources shared across turns by url", () => {
    const turnA = doneTurn({ id: "a", question: "q1" }, { answer: "a", sources: [SOURCES[0]!] });
    const turnB = doneTurn({ id: "b", question: "q2" }, { answer: "b", sources: [SOURCES[0]!, SOURCES[1]!] });
    renderWithProviders(
      <ChatView turns={[turnA, turnB]} activeTab="links" onFollowUp={mock()} busy={false} />,
    );

    // Source one appears across both turns but should render exactly once.
    expect(screen.getAllByText("https://example.com/one")).toHaveLength(1);
    expect(screen.getByText("https://docs.example.org/two")).toBeInTheDocument();
  });

  test("links tab shows an empty state when there are no sources", () => {
    const turn = doneTurn({}, { answer: "no sources here" });
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="links" onFollowUp={mock()} busy={false} />,
    );

    expect(screen.getByText("No links for this conversation yet.")).toBeInTheDocument();
  });

  // ── images tab ──────────────────────────────────────────────────────────────
  test("images tab renders each image with its description as alt text", () => {
    const turn = doneTurn({}, { answer: "x", images: IMAGES });
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="images" onFollowUp={mock()} busy={false} />,
    );

    const imgA = screen.getByAltText("Picture A") as HTMLImageElement;
    const imgB = screen.getByAltText("Picture B") as HTMLImageElement;
    expect(imgA).toHaveAttribute("src", "https://cdn.example.com/pic-a.jpg");
    expect(imgB).toHaveAttribute("src", "https://cdn.example.com/pic-b.jpg");
  });

  test("images tab shows an empty state when there are no images", () => {
    const turn = doneTurn({}, { answer: "no images" });
    renderWithProviders(
      <ChatView turns={[turn]} activeTab="images" onFollowUp={mock()} busy={false} />,
    );

    expect(screen.getByText("No images for this search.")).toBeInTheDocument();
  });

  // ── composer ────────────────────────────────────────────────────────────────
  test("typing + submitting the composer calls onFollowUp and clears the input", () => {
    const onFollowUp = mock();
    renderWithProviders(
      <ChatView turns={[doneTurn()]} activeTab="answer" onFollowUp={onFollowUp} busy={false} />,
    );

    const box = screen.getByPlaceholderText("Ask a follow-up…") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Tell me more about Lumina" } });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp.mock.calls[0]?.[0]).toBe("Tell me more about Lumina");
    // Input is reset after submit.
    expect(box.value).toBe("");
  });

  test("pressing Enter (no shift) submits the follow-up", () => {
    const onFollowUp = mock();
    renderWithProviders(
      <ChatView turns={[doneTurn()]} activeTab="answer" onFollowUp={onFollowUp} busy={false} />,
    );

    const box = screen.getByPlaceholderText("Ask a follow-up…");
    fireEvent.change(box, { target: { value: "Enter submits?" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: false });

    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp.mock.calls[0]?.[0]).toBe("Enter submits?");
  });

  test("Shift+Enter does NOT submit (newline instead)", () => {
    const onFollowUp = mock();
    renderWithProviders(
      <ChatView turns={[doneTurn()]} activeTab="answer" onFollowUp={onFollowUp} busy={false} />,
    );

    const box = screen.getByPlaceholderText("Ask a follow-up…");
    fireEvent.change(box, { target: { value: "Line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

    expect(onFollowUp).not.toHaveBeenCalled();
  });

  test("empty / whitespace-only input does not submit", () => {
    const onFollowUp = mock();
    renderWithProviders(
      <ChatView turns={[doneTurn()]} activeTab="answer" onFollowUp={onFollowUp} busy={false} />,
    );

    const box = screen.getByPlaceholderText("Ask a follow-up…");
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: false });

    expect(onFollowUp).not.toHaveBeenCalled();
    // Send button is disabled with no real text.
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
  });

  test("the send button is disabled while busy even with text", () => {
    const onFollowUp = mock();
    renderWithProviders(
      <ChatView turns={[doneTurn()]} activeTab="answer" onFollowUp={onFollowUp} busy={true} />,
    );

    const box = screen.getByPlaceholderText("Ask a follow-up…");
    fireEvent.change(box, { target: { value: "Should not send" } });

    const send = screen.getByRole("button", { name: "Send follow-up" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(onFollowUp).not.toHaveBeenCalled();
  });

  test("the composer (mic + send) is always present below the content", () => {
    renderWithProviders(
      <ChatView turns={[doneTurn()]} activeTab="images" onFollowUp={mock()} busy={false} />,
    );

    expect(screen.getByPlaceholderText("Ask a follow-up…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Voice/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Attach media")).toBeInTheDocument();
  });

  // ── multi-turn ──────────────────────────────────────────────────────────────
  test("renders every turn's question + answer in the answer tab", () => {
    const turnA = doneTurn({ id: "a", question: "First question?" }, { answer: "First answer." });
    const turnB = doneTurn({ id: "b", question: "Second question?" }, { answer: "Second answer." });
    renderWithProviders(
      <ChatView turns={[turnA, turnB]} activeTab="answer" onFollowUp={mock()} busy={false} />,
    );

    expect(screen.getByText("First question?")).toBeInTheDocument();
    expect(screen.getByText("First answer.")).toBeInTheDocument();
    expect(screen.getByText("Second question?")).toBeInTheDocument();
    expect(screen.getByText("Second answer.")).toBeInTheDocument();
  });

  test("only the last turn's follow-ups drive the Related list", () => {
    const onFollowUp = mock();
    const turnA = doneTurn({ id: "a", question: "q1" }, { answer: "a1", followUps: ["Old follow-up?"] });
    const turnB = doneTurn({ id: "b", question: "q2" }, { answer: "a2", followUps: ["New follow-up?"] });
    renderWithProviders(
      <ChatView turns={[turnA, turnB]} activeTab="answer" onFollowUp={onFollowUp} busy={false} />,
    );

    const related = screen.getByText("Related").closest("div")!;
    expect(within(related.parentElement!).getByText("New follow-up?")).toBeInTheDocument();
    expect(screen.queryByText("Old follow-up?")).not.toBeInTheDocument();
  });
});
