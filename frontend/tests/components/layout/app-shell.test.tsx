// Pure layout component: AppShell wires three slots — sidebar, header, children — into a fixed
// structure (sidebar beside a column of header-over-main). No fetch, no auth, no internal state;
// it owns no collapse/responsive logic of its own (that lives in <Sidebar/>), so the contract under
// test is purely "render each slot into the correct region". (Archetype: prop-driven layout shell.)
import { describe, expect, test } from "bun:test";

import { renderWithProviders, screen } from "@tests/helpers/utils";
import { AppShell } from "@/components/layout/app-shell";

describe("AppShell", () => {
  test("renders all three slots — sidebar, header, and children", () => {
    renderWithProviders(
      <AppShell
        sidebar={<nav>SIDEBAR_SLOT</nav>}
        header={<header>HEADER_SLOT</header>}
      >
        <p>CHILDREN_SLOT</p>
      </AppShell>,
    );

    expect(screen.getByText("SIDEBAR_SLOT")).toBeInTheDocument();
    expect(screen.getByText("HEADER_SLOT")).toBeInTheDocument();
    expect(screen.getByText("CHILDREN_SLOT")).toBeInTheDocument();
  });

  test("renders children inside the <main> content region", () => {
    renderWithProviders(
      <AppShell
        sidebar={<div>SIDEBAR_SLOT</div>}
        header={<div>HEADER_SLOT</div>}
      >
        <p>CHILDREN_SLOT</p>
      </AppShell>,
    );

    // The page's primary content is the <main> landmark; children live inside it.
    const main = screen.getByRole("main");
    expect(main).toBeInTheDocument();
    expect(main).toHaveTextContent("CHILDREN_SLOT");
    // The sidebar and header are NOT inside <main> — they sit in their own regions.
    expect(main).not.toHaveTextContent("SIDEBAR_SLOT");
    expect(main).not.toHaveTextContent("HEADER_SLOT");
  });

  test("places header and children in a column that is a sibling of the sidebar", () => {
    renderWithProviders(
      <AppShell
        sidebar={<aside data-testid="sb">SIDEBAR_SLOT</aside>}
        header={<div>HEADER_SLOT</div>}
      >
        <p>CHILDREN_SLOT</p>
      </AppShell>,
    );

    const sidebar = screen.getByTestId("sb");
    const main = screen.getByRole("main");

    // Header and main share one column wrapper; the sidebar lives outside that wrapper.
    const contentColumn = main.parentElement!;
    expect(contentColumn).toHaveTextContent("HEADER_SLOT");
    expect(contentColumn).toContainElement(main);
    expect(contentColumn).not.toContainElement(sidebar);

    // Sidebar and the content column are siblings under a shared shell root.
    const shellRoot = contentColumn.parentElement!;
    expect(shellRoot).toContainElement(sidebar);
    expect(shellRoot).toContainElement(contentColumn);
  });

  test("renders header before main in document order", () => {
    renderWithProviders(
      <AppShell
        sidebar={<div>SIDEBAR_SLOT</div>}
        header={<div data-testid="hdr">HEADER_SLOT</div>}
      >
        <p>CHILDREN_SLOT</p>
      </AppShell>,
    );

    const header = screen.getByTestId("hdr");
    const main = screen.getByRole("main");

    // Header precedes main in the rendered DOM (header sits on top, content below).
    const position = header.compareDocumentPosition(main);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("accepts rich React subtrees in each slot, not just strings", () => {
    renderWithProviders(
      <AppShell
        sidebar={
          <nav aria-label="Primary">
            <button type="button">New chat</button>
          </nav>
        }
        header={
          <div>
            <button type="button">Toggle theme</button>
          </div>
        }
      >
        <article>
          <h1>Conversation</h1>
          <button type="button">Send</button>
        </article>
      </AppShell>,
    );

    // Interactive descendants from every slot are reachable through the shell.
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle theme" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  test("renders multiple children into the content region", () => {
    renderWithProviders(
      <AppShell sidebar={<div>SIDEBAR_SLOT</div>} header={<div>HEADER_SLOT</div>}>
        <p>first child</p>
        <p>second child</p>
      </AppShell>,
    );

    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("first child");
    expect(main).toHaveTextContent("second child");
  });
});
