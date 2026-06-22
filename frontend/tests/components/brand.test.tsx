// Unit tests for the brand primitives — <LuminaMark/> (the asterisk SVG) and <LuminaWordmark/>
// (the hero wordmark). These are pure presentational components: each takes only a `className`
// that merges over a sensible default. The load-bearing assertion is the brand rule — the
// wordmark reads "lumina" / "Lumina", NEVER "Perplexity". (Archetype: pure component.)
import { describe, expect, test } from "bun:test";

import { render } from "@tests/helpers/utils";
import { LuminaMark, LuminaWordmark } from "@/components/brand";

describe("LuminaMark", () => {
  test("renders an aria-hidden SVG with the default size class", () => {
    const { container } = render(<LuminaMark />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // Decorative mark: hidden from the accessibility tree.
    expect(svg).toHaveAttribute("aria-hidden", "true");
    // Default sizing applied when no className override is given.
    expect(svg?.getAttribute("class")).toContain("size-5");
  });

  test("uses currentColor so it themes with surrounding text", () => {
    const { container } = render(<LuminaMark />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("fill", "none");
  });

  test("merges a passed className over the default size", () => {
    const { container } = render(<LuminaMark className="size-8 text-primary" />);
    const svg = container.querySelector("svg");
    const cls = svg?.getAttribute("class") ?? "";
    // tailwind-merge resolves the size conflict to the override; the new class is present.
    expect(cls).toContain("size-8");
    expect(cls).toContain("text-primary");
    expect(cls).not.toContain("size-5");
  });

  test("draws the asterisk path geometry", () => {
    const { container } = render(<LuminaMark />);
    const path = container.querySelector("svg path");
    expect(path).not.toBeNull();
    expect(path).toHaveAttribute("d");
    expect(path?.getAttribute("d")?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("LuminaWordmark", () => {
  test("renders the brand word 'lumina'", () => {
    const { container } = render(<LuminaWordmark />);
    expect(container.textContent).toBe("lumina");
  });

  test("is the Lumina brand, never Perplexity", () => {
    const { container } = render(<LuminaWordmark />);
    // Brand rule: the rendered word, case-insensitively, is "lumina".
    expect(container.textContent?.trim().toLowerCase()).toBe("lumina");
    expect(container.textContent?.toLowerCase()).not.toContain("perplexity");
  });

  test("applies the default hero styling classes", () => {
    const { container } = render(<LuminaWordmark />);
    const span = container.querySelector("span");
    const cls = span?.getAttribute("class") ?? "";
    // The CSS `lowercase` transform is why the literal text is lowercase "lumina".
    expect(cls).toContain("lowercase");
    expect(cls).toContain("text-foreground");
  });

  test("merges a passed className alongside the defaults", () => {
    const { container } = render(<LuminaWordmark className="text-2xl tracking-wide" />);
    const span = container.querySelector("span");
    const cls = span?.getAttribute("class") ?? "";
    expect(cls).toContain("text-2xl");
    // A non-conflicting default still survives the merge.
    expect(cls).toContain("font-light");
  });
});
