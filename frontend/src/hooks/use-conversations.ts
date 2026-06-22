import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteConversation,
  fetchConversations,
  renameConversation,
  type ConversationSummary,
} from "@/lib/api";

/**
 * Cache key for a user's conversation list. user.id is part of the key so the cache is
 * scoped per user (A's list never leaks to B), it auto-refetches when the account changes,
 * and `enabled: !!userId` skips the query while signed out.
 */
export const conversationsKey = (userId: string | undefined) => ["conversations", userId] as const;

/** The signed-in user's conversation history. Server state — lives in the query cache. */
export function useConversations(userId: string | undefined) {
  return useQuery({
    queryKey: conversationsKey(userId),
    queryFn: fetchConversations, // auth token carries identity; userId is only the cache key
    enabled: !!userId,
    staleTime: 30_000,
  });
}

/** Rename a conversation with an optimistic cache patch (no full re-download). */
export function useRenameConversation(userId: string | undefined) {
  const qc = useQueryClient();
  const key = conversationsKey(userId);
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameConversation(id, title),
    onMutate: async ({ id, title }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ConversationSummary[]>(key);
      qc.setQueryData<ConversationSummary[]>(key, (list = []) =>
        list.map((c) => (c.id === id ? { ...c, title } : c)),
      );
      return { previous };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/** Delete a conversation with an optimistic removal (no full re-download). */
export function useDeleteConversation(userId: string | undefined) {
  const qc = useQueryClient();
  const key = conversationsKey(userId);
  return useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ConversationSummary[]>(key);
      qc.setQueryData<ConversationSummary[]>(key, (list = []) => list.filter((c) => c.id !== id));
      return { previous };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}