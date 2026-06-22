// MicButton is the voice/mic affordance shown in every chat/search composer. As shipped it is a
// purely DECORATIVE placeholder ("coming soon") — it imports no speech API (no
// webkitSpeechRecognition / SpeechRecognition) and wires no recognizer. So instead of stubbing a
// speech class, these tests assert the accessible, non-interactive placeholder contract: it renders
// an accessible button, advertises "coming soon", merges a passed className, never submits a form,
// and starts no speech recognition when clicked (the "unsupported/disabled" state today).
import { describe, expect, test, mock } from "bun:test";

import { renderWithProviders, screen, fireEvent } from "@tests/helpers/utils";
import { MicButton } from "@/components/mic-button";

describe("MicButton", () => {
  test("renders an accessible voice button", () => {
    renderWithProviders(<MicButton />);

    const btn = screen.getByRole("button", { name: /voice/i });
    expect(btn).toBeInTheDocument();
  });

  test("advertises that voice is coming soon (label + title)", () => {
    renderWithProviders(<MicButton />);

    const btn = screen.getByRole("button", { name: /voice/i });
    // Accessible name and tooltip both signal the not-yet-wired state.
    expect(btn).toHaveAttribute("aria-label", "Voice (coming soon)");
    expect(btn).toHaveAttribute("title", expect.stringMatching(/coming soon/i));
  });

  test("is a non-submitting button (type=button) so it never posts the composer form", () => {
    renderWithProviders(<MicButton />);

    expect(screen.getByRole("button", { name: /voice/i })).toHaveAttribute("type", "button");
  });

  test("merges a caller-supplied className onto the button", () => {
    renderWithProviders(<MicButton className="my-custom-class" />);

    expect(screen.getByRole("button", { name: /voice/i })).toHaveClass("my-custom-class");
  });

  test("renders an icon inside the button (the mic glyph)", () => {
    const { container } = renderWithProviders(<MicButton />);

    // lucide-react renders an <svg>; assert the glyph is present without coupling to class strings.
    expect(container.querySelector("svg")).toBeTruthy();
  });

  test("clicking starts NO speech recognition (decorative/unsupported state today)", () => {
    // Speech-API guard: the component must not construct a recognizer. We install spies on both the
    // standard and webkit-prefixed globals; if MicButton ever wired them, the spy would be hit.
    const SpeechCtor = mock(function () {
      return { start: mock(() => {}), stop: mock(() => {}), onresult: null };
    });
    const original = {
      SpeechRecognition: (globalThis as Record<string, unknown>).SpeechRecognition,
      webkitSpeechRecognition: (globalThis as Record<string, unknown>).webkitSpeechRecognition,
    };
    (globalThis as Record<string, unknown>).SpeechRecognition = SpeechCtor;
    (globalThis as Record<string, unknown>).webkitSpeechRecognition = SpeechCtor;

    try {
      renderWithProviders(<MicButton />);
      fireEvent.click(screen.getByRole("button", { name: /voice/i }));
      // Decorative placeholder: no recognizer is ever constructed.
      expect(SpeechCtor).not.toHaveBeenCalled();
    } finally {
      (globalThis as Record<string, unknown>).SpeechRecognition = original.SpeechRecognition;
      (globalThis as Record<string, unknown>).webkitSpeechRecognition = original.webkitSpeechRecognition;
    }
  });

  test("clicking does not throw (no onClick handler wired yet)", () => {
    renderWithProviders(<MicButton />);

    const btn = screen.getByRole("button", { name: /voice/i });
    expect(() => fireEvent.click(btn)).not.toThrow();
  });
});
