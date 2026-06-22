// Component tests for the home composer (<SearchHero/>): typing + submit forwards the trimmed
// query to onSubmit, Enter submits while Shift+Enter inserts a newline, empty/whitespace input is
// blocked, the model menu selects a model via onModelChange, and the attach affordance is present.
// SearchHero is prop-driven (onSubmit/model/onModelChange) — no fetch, no auth needed.
import { describe, expect, test, mock } from "bun:test";

import { renderWithProviders, screen, fireEvent, waitFor } from "@tests/helpers/utils";
import { SearchHero } from "@/components/search-hero";
import { DEFAULT_MODEL, MODELS } from "@/components/model-menu";

const noop = () => {};

describe("SearchHero composer", () => {
  test("typing then clicking Submit calls onSubmit with the trimmed query and no attachments", () => {
    const onSubmit = mock();
    renderWithProviders(
      <SearchHero onSubmit={onSubmit} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    const box = screen.getByPlaceholderText("Ask anything…");
    fireEvent.change(box, { target: { value: "  what is pgvector  " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toBe("what is pgvector");
    expect(onSubmit.mock.calls[0]?.[1]).toEqual([]);
  });

  test("submitting clears the textarea", () => {
    const onSubmit = mock();
    renderWithProviders(
      <SearchHero onSubmit={onSubmit} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    const box = screen.getByPlaceholderText("Ask anything…") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hello there" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(box.value).toBe("");
  });

  test("Enter (no shift) submits the query", () => {
    const onSubmit = mock();
    renderWithProviders(
      <SearchHero onSubmit={onSubmit} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    const box = screen.getByPlaceholderText("Ask anything…");
    fireEvent.change(box, { target: { value: "press enter" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toBe("press enter");
  });

  test("Shift+Enter does NOT submit (newline instead)", () => {
    const onSubmit = mock();
    renderWithProviders(
      <SearchHero onSubmit={onSubmit} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    const box = screen.getByPlaceholderText("Ask anything…");
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("empty input keeps the Submit button disabled and submitting is a no-op", () => {
    const onSubmit = mock();
    renderWithProviders(
      <SearchHero onSubmit={onSubmit} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();

    // Even forcing the form submit does nothing with an empty query.
    fireEvent.submit(screen.getByPlaceholderText("Ask anything…").closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("whitespace-only input is blocked (Submit stays disabled, Enter no-ops)", () => {
    const onSubmit = mock();
    renderWithProviders(
      <SearchHero onSubmit={onSubmit} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    const box = screen.getByPlaceholderText("Ask anything…");
    fireEvent.change(box, { target: { value: "    " } });

    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("Submit button enables once the query is non-empty", () => {
    renderWithProviders(
      <SearchHero onSubmit={noop} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Ask anything…"), {
      target: { value: "now enabled" },
    });
    expect(submit).not.toBeDisabled();
  });

  test("the attach affordance is present", () => {
    renderWithProviders(
      <SearchHero onSubmit={noop} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    expect(screen.getByLabelText("Attach media")).toBeInTheDocument();
  });

  test("a suggestion chip prefills the composer (and the model menu reflects the active model)", () => {
    renderWithProviders(
      <SearchHero onSubmit={noop} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Plan a trip/ }));
    const box = screen.getByPlaceholderText("Ask anything…") as HTMLTextAreaElement;
    expect(box.value).toContain("Plan a 5-day trip");
  });

  test("the model menu trigger shows the active model's label", () => {
    renderWithProviders(
      <SearchHero onSubmit={noop} model={DEFAULT_MODEL} onModelChange={noop} />,
    );

    const active = MODELS.find((m) => m.id === DEFAULT_MODEL)!;
    expect(screen.getByRole("button", { name: new RegExp(active.name) })).toBeInTheDocument();
  });

  test("opening the model menu and selecting a different model calls onModelChange with its id", async () => {
    const onModelChange = mock();
    renderWithProviders(
      <SearchHero onSubmit={noop} model={DEFAULT_MODEL} onModelChange={onModelChange} />,
    );

    const active = MODELS.find((m) => m.id === DEFAULT_MODEL)!;
    // Open the dropdown via its trigger. Radix opens menus on keyboard activation in happy-dom
    // (no pointer-capture/layout), so focus the trigger and press Enter rather than click it.
    const trigger = screen.getByRole("button", { name: new RegExp(active.name) });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });

    // Pick a different, non-active model.
    const target = MODELS.find((m) => m.id !== DEFAULT_MODEL && !m.locked)!;
    const item = await screen.findByRole("menuitem", { name: new RegExp(target.name) });
    fireEvent.click(item);

    await waitFor(() => expect(onModelChange).toHaveBeenCalledWith(target.id));
  });
});
