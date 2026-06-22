// Sample test proving the harness end-to-end: happy-dom + Testing Library + jest-dom matchers
// + the renderWithProviders wrapper, against a real Lumina component (the top navigation bar).
// Once this is green, the same pattern scales to sidebar, dashboard, the 5 sections, connectors.
import { describe, expect, test } from "bun:test";

import { renderWithProviders, screen } from "@tests/helpers/utils";
import { SECTION_TABS, TopNav } from "@/components/layout/top-nav";

describe("TopNav", () => {
  test("renders every section tab in home mode", () => {
    renderWithProviders(<TopNav mode="home" section="Discover" />);

    for (const label of SECTION_TABS) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });

  test("renders the theme toggle button", () => {
    renderWithProviders(<TopNav mode="home" />);

    expect(
      screen.getByRole("button", { name: /switch to (light|dark) theme/i }),
    ).toBeInTheDocument();
  });

  test("shows Answer/Links/Images tabs in chat mode (not section tabs)", () => {
    renderWithProviders(<TopNav mode="chat" activeTab="answer" />);

    expect(screen.getByRole("tab", { name: /answer/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /links/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Finance" })).not.toBeInTheDocument();
  });
});
