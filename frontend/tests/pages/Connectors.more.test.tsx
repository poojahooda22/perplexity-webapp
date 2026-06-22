// Connectors page — connected-Gmail deep flows (modal → GmailCompose, send success/error,
// disconnect-triggered status refetch, OAuth denied/error banners, Escape-to-close).
// Complements Connectors.test.tsx (which covers the disconnected grid + Connect button +
// ?gmail=connected banner) — no overlap with those basic cases.
import { describe, expect, test } from "bun:test";

import {
  mockFetch,
  renderWithProviders,
  screen,
  fireEvent,
  waitFor,
  makeUser,
} from "@tests/helpers/utils";
import Connectors from "@/pages/Connectors";

const CONNECTED = { connected: true, googleEmail: "me@gmail.com" };

/** Open the Gmail detail modal from a connected page (waits for the card, then clicks it). */
async function openGmailModal() {
  fireEvent.click(await screen.findByText("Gmail"));
  // The compose box header only renders once the modal is open AND Gmail is connected.
  return screen.findByText("Send a test email");
}

describe("Connectors page — connected Gmail flows", () => {
  test("opening the connected Gmail modal reveals the GmailCompose box", async () => {
    mockFetch({ "/connectors/gmail/status": { json: CONNECTED } });
    renderWithProviders(<Connectors />, { user: makeUser() });

    await openGmailModal();

    // Connected-as line + the three compose fields are present.
    expect(screen.getByText("me@gmail.com")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    // The Disconnect button is shown (not Connect) since we're connected.
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  test("Send is disabled until To + (Subject or Body) are filled in", async () => {
    mockFetch({ "/connectors/gmail/status": { json: CONNECTED } });
    renderWithProviders(<Connectors />, { user: makeUser() });

    await openGmailModal();

    const sendBtn = screen.getByRole("button", { name: "Send email" });
    expect(sendBtn).toBeDisabled();

    // To alone is not enough.
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "you@example.com" } });
    expect(sendBtn).toBeDisabled();

    // Adding a subject satisfies the (subject || body) half → enabled.
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello" } });
    expect(sendBtn).toBeEnabled();
  });

  test("a body-only message (no subject) also enables Send", async () => {
    mockFetch({ "/connectors/gmail/status": { json: CONNECTED } });
    renderWithProviders(<Connectors />, { user: makeUser() });

    await openGmailModal();

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "you@example.com" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Just a note" } });
    expect(screen.getByRole("button", { name: "Send email" })).toBeEnabled();
  });

  test("clicking Send posts the composed email and shows the 'Sent to …' confirmation", async () => {
    const { calls } = mockFetch({
      "/connectors/gmail/status": { json: CONNECTED },
      "POST /connectors/gmail/send": { json: { id: "msg_1", threadId: "thr_1" } },
    });
    renderWithProviders(<Connectors />, { user: makeUser() });

    await openGmailModal();

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "you@example.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Quarterly update" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "See attached." } });
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));

    expect(await screen.findByText("Sent to you@example.com.")).toBeInTheDocument();

    // The POST carried the trimmed recipient + subject + body in its JSON body.
    const sendCall = calls.find(
      (c) => c.method === "POST" && c.pathname === "/connectors/gmail/send",
    );
    expect(sendCall).toBeDefined();
    expect(sendCall!.body).toMatchObject({
      to: "you@example.com",
      subject: "Quarterly update",
      body: "See attached.",
    });

    // On success the subject/body fields are cleared (component resets them).
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue(""));
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  test("a 500 send error surfaces the server-provided error text", async () => {
    mockFetch({
      "/connectors/gmail/status": { json: CONNECTED },
      "POST /connectors/gmail/send": { status: 500, json: { error: "Daily send limit reached" } },
    });
    renderWithProviders(<Connectors />, { user: makeUser() });

    await openGmailModal();

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "you@example.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));

    expect(await screen.findByText("Daily send limit reached")).toBeInTheDocument();
    // No success confirmation appeared.
    expect(screen.queryByText(/^Sent to/)).not.toBeInTheDocument();
  });

  test("clicking Disconnect calls DELETE then refetches status (card flips to disconnected)", async () => {
    // Status starts connected; after the DELETE fires, subsequent status fetches return
    // disconnected — the invalidate-on-success refetch should pick that up.
    let disconnected = false;
    const { calls } = mockFetch((info) => {
      if (info.pathname === "/connectors/gmail/status") {
        return { json: disconnected ? { connected: false } : CONNECTED };
      }
      if (info.method === "DELETE" && info.pathname === "/connectors/gmail") {
        disconnected = true;
        return { json: {} };
      }
      return { status: 404, json: {} };
    });

    renderWithProviders(<Connectors />, { user: makeUser() });

    await openGmailModal();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    // DELETE was issued…
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.pathname === "/connectors/gmail"),
      ).toBe(true),
    );

    // …and the status was refetched after the disconnect (more than the initial load).
    await waitFor(() => {
      const statusCalls = calls.filter((c) => c.pathname === "/connectors/gmail/status");
      expect(statusCalls.length).toBeGreaterThan(1);
    });

    // The grid no longer shows the Connected badge once the refetch resolves.
    await waitFor(() => expect(screen.queryByText("Connected")).not.toBeInTheDocument());
  });

  test("Escape closes the open modal", async () => {
    mockFetch({ "/connectors/gmail/status": { json: CONNECTED } });
    renderWithProviders(<Connectors />, { user: makeUser() });

    await openGmailModal();
    expect(screen.getByText("Send a test email")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText("Send a test email")).not.toBeInTheDocument());
  });

  test("?gmail=denied shows the cancelled-consent banner", async () => {
    mockFetch({ "/connectors/gmail/status": { json: { connected: false } } });
    renderWithProviders(<Connectors />, {
      user: makeUser(),
      route: "/connectors?gmail=denied",
    });

    expect(
      await screen.findByText(
        "Connection cancelled — you declined the Google consent screen.",
      ),
    ).toBeInTheDocument();
  });

  test("?gmail=error shows the generic failure banner", async () => {
    mockFetch({ "/connectors/gmail/status": { json: { connected: false } } });
    renderWithProviders(<Connectors />, {
      user: makeUser(),
      route: "/connectors?gmail=error",
    });

    expect(
      await screen.findByText("Something went wrong connecting Gmail. Please try again."),
    ).toBeInTheDocument();
  });
});
