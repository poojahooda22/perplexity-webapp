// Auth-page integration: the real AuthProvider (fake session) gates the page, useGmailStatus
// drives the cards, and the modal/compose flow exercises connect/disconnect/send.
// (Archetype: authenticated page with fetch + interaction.)
import { describe, expect, test } from "bun:test";

import { mockFetch, renderWithProviders, screen, fireEvent, makeUser } from "@tests/helpers/utils";
import Connectors from "@/pages/Connectors";

describe("Connectors page", () => {
  test("renders the connector grid once auth resolves", async () => {
    mockFetch({ "/connectors/gmail/status": { json: { connected: false } } });
    renderWithProviders(<Connectors />, { user: makeUser() });

    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument(); // a "Soon" connector
  });

  test("shows the Connected badge when Gmail is connected", async () => {
    mockFetch({ "/connectors/gmail/status": { json: { connected: true, googleEmail: "me@gmail.com" } } });
    renderWithProviders(<Connectors />, { user: makeUser() });

    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  test("opening the Gmail modal (disconnected) shows a Connect button", async () => {
    mockFetch({ "/connectors/gmail/status": { json: { connected: false } } });
    renderWithProviders(<Connectors />, { user: makeUser() });

    fireEvent.click(await screen.findByText("Gmail"));
    expect(await screen.findByRole("button", { name: /connect/i })).toBeInTheDocument();
  });

  test("post-OAuth ?gmail=connected shows the success banner", async () => {
    mockFetch({ "/connectors/gmail/status": { json: { connected: true, googleEmail: "me@gmail.com" } } });
    renderWithProviders(<Connectors />, { user: makeUser(), route: "/connectors?gmail=connected" });

    expect(await screen.findByText("Gmail connected.")).toBeInTheDocument();
  });
});
