// Dashboard shell integration: the real AuthProvider (fake session) gates the page, the TopNav
// section tabs swap the home surface (Discover→SearchHero, Finance→FinanceView, Academic→
// AcademicView, Health→HealthView), and the profile menu drives sign-out. We never submit a query,
// so the chat-stream path is not exercised. (Archetype: authenticated page with fetch + interaction.)
import { describe, expect, test, spyOn } from "bun:test";

import {
  mockFetch,
  renderWithProviders,
  screen,
  fireEvent,
  waitFor,
  makeUser,
  type Routes,
} from "@tests/helpers/utils";
import { supabase } from "@/lib/supabase";
import Dashboard from "@/pages/Dashboard";

const prov = { source: "Yahoo", commercialOk: false, attribution: "Live · Yahoo" };
const PAST = "2026-06-22T00:00:00Z";

// Radix Tabs triggers select on a mousedown (not a synthetic click in happy-dom).
function pressTab(el: HTMLElement) {
  fireEvent.mouseDown(el);
}

// Radix DropdownMenu opens on a pointerdown; happy-dom needs it dispatched explicitly, then a
// click to settle the open state. (Same helper the Sidebar/ProfileMenu tests use.)
function openMenu(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
  fireEvent.click(el);
}

// Broad happy-path router covering every endpoint the dashboard's section views can touch, with
// empty-but-valid payloads. Spread overrides on top for a per-test edge case.
function dashboardRoutes(overrides: Routes = {}): Routes {
  return {
    // Sidebar conversation list (signed-in) — empty history.
    "/conversations": { json: { conversations: [] } },

    // Finance section — FinanceView fans out to all of these on mount.
    "/finance/indices": { json: { items: [], provenance: prov } },
    "/finance/summary": { json: { items: [], sources: [], updatedAt: PAST, provenance: prov } },
    "/finance/sectors": { json: { items: [], provenance: prov } },
    "/finance/stocks": { json: { items: [], provenance: prov, currency: "USD" } },
    "/finance/crypto": { json: { coins: [], provenance: prov } },
    "/finance/predictions": { json: { markets: [], provenance: { ...prov, unit: "USD" } } },
    "/finance/discover": { json: { articles: [], provenance: prov } },
    "/finance/research": { json: { notes: [] } },

    // Discover feeds — Academic view is static (no fetch) but we mock it harmlessly; Health fetches.
    "/discover/academic": { json: { articles: [], provenance: prov } },
    "/discover/health": { json: { articles: [], provenance: prov } },

    ...(overrides as Record<string, unknown>),
  } as Routes;
}

describe("Dashboard", () => {
  test("shows a loading spinner before auth resolves", () => {
    mockFetch(dashboardRoutes());
    const { container } = renderWithProviders(<Dashboard />, { user: makeUser() });

    // AuthProvider starts with loading:true (getSession resolves on a microtask), so the very first
    // synchronous render is the centered spinner, not the shell.
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  test("default section is Discover and renders the SearchHero", async () => {
    mockFetch(dashboardRoutes());
    renderWithProviders(<Dashboard />, { user: makeUser() });

    // SearchHero's composer placeholder is the stable, accessible signal of the Discover surface.
    expect(await screen.findByPlaceholderText("Ask anything…")).toBeInTheDocument();
    // The home TopNav exposes the five section tabs.
    expect(await screen.findByRole("tab", { name: "Finance" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Discover" })).toBeInTheDocument();
  });

  test("switching the section tab to Finance renders FinanceView", async () => {
    mockFetch(dashboardRoutes());
    renderWithProviders(<Dashboard />, { user: makeUser() });

    pressTab(await screen.findByRole("tab", { name: "Finance" }));

    // FinanceView's Markets tab shows the "Top Assets" heading once mounted.
    expect(await screen.findByRole("heading", { name: "Top Assets" })).toBeInTheDocument();
  });

  test("switching the section tab to Academic renders AcademicView", async () => {
    mockFetch(dashboardRoutes());
    renderWithProviders(<Dashboard />, { user: makeUser() });

    pressTab(await screen.findByRole("tab", { name: "Academic" }));

    expect(await screen.findByPlaceholderText("Explore academic papers, journals, and more")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trending Topics" })).toBeInTheDocument();
  });

  test("switching the section tab to Health renders HealthView", async () => {
    mockFetch(dashboardRoutes());
    renderWithProviders(<Dashboard />, { user: makeUser() });

    pressTab(await screen.findByRole("tab", { name: "Health" }));

    expect(await screen.findByRole("heading", { name: "Lumina Health" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Health Workflows" })).toBeInTheDocument();
  });

  test("Health view surfaces the empty-feed message when the discover payload has no articles", async () => {
    mockFetch(dashboardRoutes());
    renderWithProviders(<Dashboard />, { user: makeUser() });

    pressTab(await screen.findByRole("tab", { name: "Health" }));

    expect(await screen.findByText(/No health news right now/)).toBeInTheDocument();
  });

  test("signing out via the profile menu calls supabase.auth.signOut", async () => {
    const signOutSpy = spyOn(supabase.auth, "signOut");
    mockFetch(dashboardRoutes());
    renderWithProviders(<Dashboard />, { user: makeUser() });

    // Open the profile menu (the trigger's accessible name includes the user's display name).
    openMenu(await screen.findByRole("button", { name: /Open user menu/i }));
    // Radix portals the menu into document.body; the Sign out item is a menuitem.
    fireEvent.click(await screen.findByRole("menuitem", { name: /sign out/i }));

    await waitFor(() => expect(signOutSpy).toHaveBeenCalled());
    signOutSpy.mockRestore();
  });
});
