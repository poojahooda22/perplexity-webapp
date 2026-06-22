// Unit + interaction tests for the model picker. The trigger shows the active model's label;
// opening the Radix dropdown (which portals into document.body) lists every MODELS option, and
// selecting one fires onChange with that model's id. DEFAULT_MODEL is the exported default seed.
// (Archetype: prop-driven component with a Radix dropdown → search the whole document.)
import { describe, expect, test, mock } from "bun:test";

import { renderWithProviders, screen, fireEvent, waitFor } from "@tests/helpers/utils";
import {
  ModelMenu,
  MODELS,
  DEFAULT_MODEL,
  modelLabel,
} from "@/components/model-menu";

// Open the Radix dropdown trigger. Radix reacts to a pointerdown; happy-dom needs it dispatched
// explicitly, then a click to settle the open state.
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe("model-menu — exports", () => {
  test("DEFAULT_MODEL is a real model id present in MODELS", () => {
    expect(DEFAULT_MODEL).toBe("anthropic/claude-sonnet-4.6");
    expect(MODELS.some((m) => m.id === DEFAULT_MODEL)).toBe(true);
  });

  test("modelLabel resolves an id to its display name, and falls back gracefully", () => {
    expect(modelLabel(DEFAULT_MODEL)).toBe("Claude Sonnet 4.6");
    expect(modelLabel("does/not-exist")).toBe("Model");
  });
});

describe("ModelMenu", () => {
  test("the trigger shows the active model's label", () => {
    renderWithProviders(<ModelMenu value={DEFAULT_MODEL} onChange={mock()} />);
    // The default model's name appears on the trigger button.
    expect(screen.getByRole("button", { name: /Claude Sonnet 4.6/ })).toBeInTheDocument();
  });

  test("the active label reflects whichever value prop is passed", () => {
    renderWithProviders(<ModelMenu value="openai/gpt-5.5-pro" onChange={mock()} />);
    expect(screen.getByRole("button", { name: /GPT-5.5 Pro/ })).toBeInTheDocument();
    // A non-active model is NOT shown until the menu opens.
    expect(screen.queryByText("Grok 4.3")).not.toBeInTheDocument();
  });

  test("opening the menu lists every model option in the portal", async () => {
    renderWithProviders(<ModelMenu value={DEFAULT_MODEL} onChange={mock()} />);

    openMenu(screen.getByRole("button"));

    // Radix portals the content into document.body; screen.* searches the whole document.
    // Wait for the menu to open, then assert every option is present by exact accessible name.
    // The accessible name = the model name (+ its badge text, e.g. "Claude Opus 4.7 Max"),
    // so anchor on the exact name span to avoid "GPT-5.5" matching "GPT-5.5 Pro".
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(MODELS.length);
    for (const model of MODELS) {
      const named = items.filter((el) => el.textContent?.replace(/\s+/g, " ").trim().startsWith(model.name));
      expect(named.length).toBeGreaterThan(0);
    }
  });

  test("selecting a model calls onChange with that model's id", async () => {
    const onChange = mock();
    renderWithProviders(<ModelMenu value={DEFAULT_MODEL} onChange={onChange} />);

    openMenu(screen.getByRole("button"));

    const grok = MODELS.find((m) => m.id === "xai/grok-4.3")!;
    const item = await screen.findByRole("menuitem", { name: new RegExp(grok.name) });
    fireEvent.click(item);

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith("xai/grok-4.3");
  });

  test("selecting the already-active model still forwards its id to onChange", async () => {
    const onChange = mock();
    renderWithProviders(<ModelMenu value={DEFAULT_MODEL} onChange={onChange} />);

    openMenu(screen.getByRole("button"));

    const active = await screen.findByRole("menuitem", { name: /Claude Sonnet 4.6/ });
    fireEvent.click(active);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(DEFAULT_MODEL));
  });
});
