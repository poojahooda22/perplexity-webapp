import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { gmailDisconnect, gmailSend, gmailStatus, type GmailSendInput } from "@/lib/api";

// Same TanStack pattern as use-finance.ts: server state lives in the query cache so the UI
// reads one source of truth, and mutations invalidate it instead of hand-managing useState.
const GMAIL_STATUS_KEY = ["connectors", "gmail", "status"] as const;

/** Is Gmail connected (and as which address)? Cached + shared across components. */
export function useGmailStatus() {
  return useQuery({
    queryKey: GMAIL_STATUS_KEY,
    queryFn: gmailStatus,
    staleTime: 30_000,
  });
}

/** Disconnect Gmail, then refetch status so every card/modal updates at once. */
export function useGmailDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: gmailDisconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: GMAIL_STATUS_KEY }),
  });
}

/** Send an email via the connected account. */
export function useGmailSend() {
  return useMutation({ mutationFn: (input: GmailSendInput) => gmailSend(input) });
}

/** Force a status refetch (used after returning from the OAuth round-trip). */
export function useInvalidateGmailStatus() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: GMAIL_STATUS_KEY });
}
