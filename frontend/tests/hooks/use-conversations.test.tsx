// Hook tests — the per-user conversation list + its two optimistic mutations.
// (Archetype: data hook with optimistic cache mutations.) Proves the query is gated on a
// userId, and that rename/delete patch the cache immediately then settle — rolling back on
// error. We seed the cache through the shared QueryClient and assert the cached list, since
// these mutations are cache-first (no full re-download until onSettled invalidates).
import { describe, expect, test } from "bun:test";

import {
  act,
  makeUser,
  mockFetch,
  renderHookWithProviders,
  waitFor,
  type MockResponse,
} from "@tests/helpers/utils";
import {
  conversationsKey,
  useConversations,
  useDeleteConversation,
  useRenameConversation,
} from "@/hooks/use-conversations";
import type { ConversationSummary } from "@/lib/api";
import { QueryClient } from "@tanstack/react-query";

const USER_ID = "test-user-id";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const convo = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "c1",
  title: "First chat",
  slug: "first-chat",
  ...over,
});

const SEED: ConversationSummary[] = [
  convo({ id: "c1", title: "First chat", slug: "first-chat" }),
  convo({ id: "c2", title: "Second chat", slug: "second-chat" }),
];

// A retry-off client we own, so we can both seed AND read the cache the mutations mutate.
// gcTime stays positive so the seeded list survives even before an observer mounts.
function seededClient(list: ConversationSummary[] = SEED): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  qc.setQueryData(conversationsKey(USER_ID), list);
  return qc;
}

const titles = (qc: QueryClient) =>
  (qc.getQueryData<ConversationSummary[]>(conversationsKey(USER_ID)) ?? []).map((c) => c.title);
const ids = (qc: QueryClient) =>
  (qc.getQueryData<ConversationSummary[]>(conversationsKey(USER_ID)) ?? []).map((c) => c.id);

describe("use-conversations", () => {
  describe("useConversations", () => {
    test("is disabled while userId is undefined — no fetch fires", async () => {
      const { calls } = mockFetch({ "/conversations": { json: { conversations: SEED } } });
      const { result } = renderHookWithProviders(() => useConversations(undefined), {
        user: makeUser(),
      });

      // The query is gated by `enabled: !!userId`; it stays disabled and never hits the network.
      await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toBeUndefined();
      expect(calls.length).toBe(0);
    });

    test("resolves to the conversation list when userId is set", async () => {
      const { calls } = mockFetch({ "/conversations": { json: { conversations: SEED } } });
      const { result } = renderHookWithProviders(() => useConversations(USER_ID), {
        user: makeUser(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.map((c) => c.id)).toEqual(["c1", "c2"]);
      expect(result.current.data?.[0]?.title).toBe("First chat");
      // it hit the real /conversations endpoint with the signed-in token
      expect(calls.some((c) => c.pathname === "/conversations")).toBe(true);
      expect(calls[0]?.headers.get("authorization")).toBe("test-token");
    });

    test("surfaces isError when the server 500s", async () => {
      mockFetch({ "/conversations": { status: 500 } });
      const { result } = renderHookWithProviders(() => useConversations(USER_ID), {
        user: makeUser(),
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
    });
  });

  describe("useRenameConversation", () => {
    test("optimistically patches the title, then settles via invalidation", async () => {
      // PATCH succeeds; the onSettled invalidate refetches /conversations with the renamed row.
      const renamed: ConversationSummary[] = [
        convo({ id: "c1", title: "Renamed!", slug: "first-chat" }),
        SEED[1]!,
      ];
      mockFetch({
        "PATCH /conversations/c1": { json: {} },
        "GET /conversations": { json: { conversations: renamed } },
      });

      const queryClient = seededClient();
      const { result } = renderHookWithProviders(() => useRenameConversation(USER_ID), {
        user: makeUser(),
        queryClient,
      });

      // Fire the mutation; the optimistic onMutate runs synchronously inside this act.
      act(() => {
        result.current.mutate({ id: "c1", title: "Renamed!" });
      });

      // Optimistic patch is visible immediately — before the network settles.
      await waitFor(() => expect(titles(queryClient)).toContain("Renamed!"));
      expect(titles(queryClient)).toEqual(["Renamed!", "Second chat"]);

      // Mutation settles successfully and the refetched (also-renamed) list sticks.
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      await waitFor(() => expect(titles(queryClient)).toEqual(["Renamed!", "Second chat"]));
    });

    test("rolls back the optimistic patch when the rename fails", async () => {
      // PATCH 500s (held open briefly so the optimistic window is observable) → onError
      // restores `previous`; onSettled still invalidates (GET returns the original list).
      mockFetch({
        "PATCH /conversations/c1": async (): Promise<MockResponse> => {
          await delay(250);
          return { status: 500 };
        },
        "GET /conversations": { json: { conversations: SEED } },
      });

      const queryClient = seededClient();
      const { result } = renderHookWithProviders(() => useRenameConversation(USER_ID), {
        user: makeUser(),
        queryClient,
      });

      act(() => {
        result.current.mutate({ id: "c1", title: "Renamed!" });
      });

      // The optimistic title shows up first…
      await waitFor(() => expect(titles(queryClient)).toContain("Renamed!"));

      // …then the failure rolls the cache back to the original titles.
      await waitFor(() => expect(result.current.isError).toBe(true));
      await waitFor(() => expect(titles(queryClient)).toEqual(["First chat", "Second chat"]));
    });
  });

  describe("useDeleteConversation", () => {
    test("optimistically removes the row, then settles via invalidation", async () => {
      // DELETE succeeds; the onSettled refetch returns the list without c1.
      mockFetch({
        "DELETE /conversations/c1": { json: {} },
        "GET /conversations": { json: { conversations: [SEED[1]] } },
      });

      const queryClient = seededClient();
      const { result } = renderHookWithProviders(() => useDeleteConversation(USER_ID), {
        user: makeUser(),
        queryClient,
      });

      act(() => {
        result.current.mutate("c1");
      });

      // c1 disappears from the cache immediately.
      await waitFor(() => expect(ids(queryClient)).toEqual(["c2"]));

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      await waitFor(() => expect(ids(queryClient)).toEqual(["c2"]));
    });

    test("rolls back the optimistic removal when the delete fails", async () => {
      // DELETE 500s (held open briefly so the optimistic window is observable).
      mockFetch({
        "DELETE /conversations/c1": async (): Promise<MockResponse> => {
          await delay(250);
          return { status: 500 };
        },
        "GET /conversations": { json: { conversations: SEED } },
      });

      const queryClient = seededClient();
      const { result } = renderHookWithProviders(() => useDeleteConversation(USER_ID), {
        user: makeUser(),
        queryClient,
      });

      act(() => {
        result.current.mutate("c1");
      });

      // Optimistic removal first…
      await waitFor(() => expect(ids(queryClient)).toEqual(["c2"]));

      // …then rollback restores c1.
      await waitFor(() => expect(result.current.isError).toBe(true));
      await waitFor(() => expect(ids(queryClient)).toEqual(["c1", "c2"]));
    });
  });
});
