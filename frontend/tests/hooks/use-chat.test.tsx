// The core chat pipeline: ask → streamed answer → follow-up → error → load history. Drives the
// real streamAsk/streamFollowUp/fetchConversation through mockFetch's streamed-body support, so
// it exercises both use-chat.ts and api.ts's streamPost reader loop.
import { describe, expect, test } from "bun:test";

import { act, makeUser, mockFetch, renderHookWithProviders, waitFor } from "@tests/helpers/utils";
import { useChat } from "@/hooks/use-chat";

const opts = { model: "openai/gpt-4o", section: "Discover" as const, userId: "test-user-id" };

describe("useChat", () => {
  test("handleAsk streams an answer to done and captures the conversation id", async () => {
    const { calls } = mockFetch({
      "POST /perplexity_ask": { stream: ["Hello", " world"], headers: { "x-conversation-id": "conv-1" } },
    });
    const { result } = renderHookWithProviders(() => useChat(opts), { user: makeUser() });

    act(() => result.current.handleAsk("hi there"));

    await waitFor(() => expect(result.current.turns[0]?.status).toBe("done"));
    expect(result.current.turns[0]?.question).toBe("hi there");
    expect(result.current.turns[0]?.full).toBe("Hello world");
    expect(result.current.conversationId).toBe("conv-1");
    expect(result.current.busy).toBe(false);
    // Discover section → "discover" vertical in the request body.
    expect((calls[0]?.body as { vertical?: string })?.vertical).toBe("discover");
  });

  test("Finance section sends the finance vertical", async () => {
    const { calls } = mockFetch({ "POST /perplexity_ask": { stream: "ok", headers: { "x-conversation-id": "c" } } });
    const { result } = renderHookWithProviders(() => useChat({ ...opts, section: "Finance" }), { user: makeUser() });

    act(() => result.current.handleAsk("what moved markets"));
    await waitFor(() => expect(result.current.turns[0]?.status).toBe("done"));
    expect((calls[0]?.body as { vertical?: string })?.vertical).toBe("finance");
  });

  test("handleFollowUp hits the follow_up endpoint with the existing conversation id", async () => {
    const { calls } = mockFetch({
      "POST /perplexity_ask": { stream: "first", headers: { "x-conversation-id": "conv-7" } },
      "POST /perplexity_ask/follow_up": { stream: "second" },
    });
    const { result } = renderHookWithProviders(() => useChat(opts), { user: makeUser() });

    act(() => result.current.handleAsk("q1"));
    await waitFor(() => expect(result.current.conversationId).toBe("conv-7"));

    act(() => result.current.handleFollowUp("q2"));
    await waitFor(() => expect(result.current.turns).toHaveLength(2));
    expect(result.current.turns[1]?.full).toBe("second");

    const followUp = calls.find((c) => c.pathname === "/perplexity_ask/follow_up");
    expect((followUp?.body as { conversationId?: string })?.conversationId).toBe("conv-7");
  });

  test("a failed request marks the turn as error with the server message", async () => {
    mockFetch({ "POST /perplexity_ask": { status: 500, text: "boom" } });
    const { result } = renderHookWithProviders(() => useChat(opts), { user: makeUser() });

    act(() => result.current.handleAsk("explode"));
    await waitFor(() => expect(result.current.turns[0]?.status).toBe("error"));
    expect(result.current.turns[0]?.error).toBe("boom");
    expect(result.current.busy).toBe(false);
  });

  test("handleSelectConversation loads and pairs Q/A messages into turns", async () => {
    mockFetch({
      "/conversations/conv-9": {
        json: {
          conversation: {
            id: "conv-9",
            title: "Past chat",
            slug: "past-chat",
            messages: [
              { id: 1, role: "user", content: "What is X?" },
              { id: 2, role: "Assistant", content: "X is Y." },
            ],
          },
        },
      },
    });
    const { result } = renderHookWithProviders(() => useChat(opts), { user: makeUser() });

    await act(async () => {
      await result.current.handleSelectConversation("conv-9");
    });

    expect(result.current.conversationId).toBe("conv-9");
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0]?.question).toBe("What is X?");
    expect(result.current.turns[0]?.full).toBe("X is Y.");
  });

  test("handleNewChat and resetIfActive clear the open conversation", async () => {
    mockFetch({ "POST /perplexity_ask": { stream: "hi", headers: { "x-conversation-id": "conv-3" } } });
    const { result } = renderHookWithProviders(() => useChat(opts), { user: makeUser() });

    act(() => result.current.handleAsk("q"));
    await waitFor(() => expect(result.current.conversationId).toBe("conv-3"));

    act(() => result.current.resetIfActive("conv-3"));
    expect(result.current.turns).toHaveLength(0);
    expect(result.current.conversationId).toBeNull();

    act(() => result.current.handleNewChat());
    expect(result.current.turns).toHaveLength(0);
  });
});
