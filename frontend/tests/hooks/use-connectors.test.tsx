// Connector hook tests — TanStack Query + mutation states for Gmail, driven by the fetch mock.
// (Archetype: data + mutation hooks.) Covers the status query (success/error), the send mutation
// (success payload + server-error rejection), and disconnect invalidating the status cache.
import { describe, expect, test } from "bun:test";

import { mockFetch, renderHookWithProviders, makeUser, waitFor } from "@tests/helpers/utils";
import {
  useGmailStatus,
  useGmailSend,
  useGmailDisconnect,
} from "@/hooks/use-connectors";

const sendInput = { to: "a@b.com", subject: "Hi", body: "Hello there" };

describe("use-connectors", () => {
  test("useGmailStatus resolves to the connected status payload", async () => {
    mockFetch({
      "/connectors/gmail/status": { json: { connected: true, googleEmail: "me@gmail.com" } },
    });
    const { result } = renderHookWithProviders(() => useGmailStatus(), { user: makeUser() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.connected).toBe(true);
    expect(result.current.data?.googleEmail).toBe("me@gmail.com");
  });

  test("useGmailStatus surfaces isError on 500", async () => {
    mockFetch({ "/connectors/gmail/status": { status: 500 } });
    const { result } = renderHookWithProviders(() => useGmailStatus(), { user: makeUser() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  test("useGmailSend mutate success returns { id, threadId }", async () => {
    const { calls } = mockFetch({
      "POST /connectors/gmail/send": { json: { id: "msg-1", threadId: "thread-9" } },
    });
    const { result } = renderHookWithProviders(() => useGmailSend(), { user: makeUser() });

    result.current.mutate(sendInput);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: "msg-1", threadId: "thread-9" });

    // The input rode the request body through to the backend.
    const send = calls.find((c) => c.pathname === "/connectors/gmail/send");
    expect(send?.method).toBe("POST");
    expect(send?.body).toEqual(sendInput);
  });

  test("useGmailSend rejects with the server's { error } message on !ok", async () => {
    mockFetch({
      "POST /connectors/gmail/send": { status: 403, json: { error: "Gmail not connected" } },
    });
    const { result } = renderHookWithProviders(() => useGmailSend(), { user: makeUser() });

    result.current.mutate(sendInput);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe("Gmail not connected");
  });

  test("useGmailDisconnect succeeds and invalidates the status query (a second GET status fires)", async () => {
    const { calls } = mockFetch({
      "GET /connectors/gmail/status": { json: { connected: true, googleEmail: "me@gmail.com" } },
      "DELETE /connectors/gmail": { json: {} },
    });

    // Mount the status query alongside the mutation so invalidation has an active observer to refetch.
    const { result } = renderHookWithProviders(
      () => ({ status: useGmailStatus(), disconnect: useGmailDisconnect() }),
      { user: makeUser() },
    );

    // Initial status load → exactly one GET so far.
    await waitFor(() => expect(result.current.status.isSuccess).toBe(true));
    const statusGets = () =>
      calls.filter((c) => c.pathname === "/connectors/gmail/status" && c.method === "GET").length;
    expect(statusGets()).toBe(1);

    // Disconnect.
    result.current.disconnect.mutate();
    await waitFor(() => expect(result.current.disconnect.isSuccess).toBe(true));

    // A DELETE went out…
    expect(calls.some((c) => c.pathname === "/connectors/gmail" && c.method === "DELETE")).toBe(true);
    // …and onSuccess invalidated the status query → a SECOND GET status refetch.
    await waitFor(() => expect(statusGets()).toBeGreaterThanOrEqual(2));
  });
});
