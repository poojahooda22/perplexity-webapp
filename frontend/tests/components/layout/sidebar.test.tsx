// Prop-driven sidebar: no fetch, but it calls useNavigate, so it needs a Router (provided by
// renderWithProviders). `user` here is a PROP we pass directly (makeUser()), NOT the auth render
// option — the component is pure UI, so we omit `user` from the render opts and skip AuthProvider.
// Conversation row actions (Rename/Delete) live in a Radix DropdownMenu that portals to
// document.body, so we drive them via screen.* and assert the handler mocks fire.
import { describe, expect, test, mock } from "bun:test";

import {
  renderWithProviders,
  screen,
  fireEvent,
  within,
  makeUser,
} from "@tests/helpers/utils";
import { Sidebar } from "@/components/layout/sidebar";
import type { ConversationSummary } from "@/lib/api";

// Open a Radix dropdown trigger. Radix reacts to a pointerdown; happy-dom needs it dispatched
// explicitly, then a click to settle the open state. (Same helper the ProfileMenu test uses.)
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

const CONVERSATIONS: ConversationSummary[] = [
  { id: "c1", title: "Quarterly market recap", slug: "quarterly-market-recap" },
  { id: "c2", title: "  ", slug: "blank-title" }, // whitespace → "Untitled" fallback
  { id: "c3", title: null, slug: "null-title" }, // null → "Untitled" fallback
];

// Build the full prop set with fresh mock() handlers each test; spread overrides on top.
function makeProps(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return {
    user: makeUser(),
    conversations: CONVERSATIONS,
    loadingConversations: false,
    activeConversationId: null,
    onNewChat: mock(),
    onSelectConversation: mock(),
    onRenameConversation: mock(),
    onDeleteConversation: mock(),
    onSignOut: mock(),
    ...overrides,
  };
}

describe("Sidebar", () => {
  test("loading: shows the skeleton placeholders, not the empty/list states", () => {
    renderWithProviders(<Sidebar {...makeProps({ loadingConversations: true, conversations: [] })} />);

    // History header is present...
    expect(screen.getByText("History")).toBeInTheDocument();
    // ...but neither the empty copy nor a real conversation title is shown while loading.
    expect(screen.queryByText("No conversations yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("Quarterly market recap")).not.toBeInTheDocument();
  });

  test("empty: renders the 'No conversations yet.' message", () => {
    renderWithProviders(<Sidebar {...makeProps({ conversations: [] })} />);

    expect(screen.getByText("No conversations yet.")).toBeInTheDocument();
  });

  test("success: renders conversation titles with the 'Untitled' fallback", () => {
    renderWithProviders(<Sidebar {...makeProps()} />);

    expect(screen.getByText("Quarterly market recap")).toBeInTheDocument();
    // Two rows have empty/whitespace/null titles → both fall back to "Untitled".
    expect(screen.getAllByText("Untitled")).toHaveLength(2);
  });

  test("clicking a conversation row calls onSelectConversation with its id", () => {
    const onSelectConversation = mock();
    renderWithProviders(<Sidebar {...makeProps({ onSelectConversation })} />);

    fireEvent.click(screen.getByText("Quarterly market recap"));

    expect(onSelectConversation).toHaveBeenCalledTimes(1);
    expect(onSelectConversation).toHaveBeenCalledWith("c1");
  });

  test("the New button calls onNewChat", () => {
    const onNewChat = mock();
    renderWithProviders(<Sidebar {...makeProps({ onNewChat })} />);

    fireEvent.click(screen.getByText("New"));

    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  test("collapse toggle flips its aria-label between Collapse and Expand", () => {
    renderWithProviders(<Sidebar {...makeProps()} />);

    // Starts expanded → the control collapses it.
    const collapseBtn = screen.getByRole("button", { name: "Collapse sidebar" });
    fireEvent.click(collapseBtn);

    // After collapsing, the same control now offers to expand.
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
  });

  test("the ⋯ menu → Rename: typing a new title + Enter calls onRenameConversation", async () => {
    const onRenameConversation = mock();
    renderWithProviders(<Sidebar {...makeProps({ onRenameConversation })} />);

    // Open the row's options menu (Radix portal → document.body).
    const optionButtons = screen.getAllByRole("button", { name: "Conversation options" });
    openMenu(optionButtons[0]!);

    fireEvent.click(await screen.findByRole("menuitem", { name: /rename/i }));

    // The inline rename input replaces the row's button; type a new title + Enter to commit.
    const input = await screen.findByDisplayValue("Quarterly market recap");
    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRenameConversation).toHaveBeenCalledTimes(1);
    expect(onRenameConversation).toHaveBeenCalledWith("c1", "Renamed thread");
  });

  test("the ⋯ menu → Delete calls onDeleteConversation with the row id", async () => {
    const onDeleteConversation = mock();
    renderWithProviders(<Sidebar {...makeProps({ onDeleteConversation })} />);

    const optionButtons = screen.getAllByRole("button", { name: "Conversation options" });
    openMenu(optionButtons[0]!);

    fireEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));

    expect(onDeleteConversation).toHaveBeenCalledTimes(1);
    expect(onDeleteConversation).toHaveBeenCalledWith("c1");
  });

  test("the Connectors nav row is present and is a navigable button", () => {
    renderWithProviders(<Sidebar {...makeProps()} />);

    // SECONDARY_NAV renders Connectors; it navigates via useNavigate (Router supplied).
    const connectors = screen.getByRole("button", { name: "Connectors" });
    expect(connectors).toBeInTheDocument();
    // Clicking should not throw (navigate is wired through MemoryRouter).
    fireEvent.click(connectors);
  });

  test("brand: the sidebar header reads 'Lumina'", () => {
    renderWithProviders(<Sidebar {...makeProps()} />);

    expect(screen.getByText("Lumina")).toBeInTheDocument();
    expect(screen.queryByText("Perplexity")).not.toBeInTheDocument();
  });

  test("the active conversation row is marked active and still selectable", () => {
    const onSelectConversation = mock();
    renderWithProviders(
      <Sidebar {...makeProps({ activeConversationId: "c1", onSelectConversation })} />,
    );

    const list = screen.getByRole("list");
    const activeRow = within(list).getByText("Quarterly market recap");
    fireEvent.click(activeRow);

    expect(onSelectConversation).toHaveBeenCalledWith("c1");
  });
});
