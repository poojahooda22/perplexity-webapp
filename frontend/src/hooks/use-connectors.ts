import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { gmailDisconnect, gmailSend, gmailStatus, type GmailSendInput } from "@/lib/api";

// Same TanStack pattern as use-finance.ts: server state lives in the query cache so the UI
// reads one source of truth, and mutations invalidate it instead of hand-managing useState.
const GMAIL_STATUS_KEY = ["connectors", "gmail", "status"] as const;

// Persist the last-known status so a cold mount / refocus paints the right state INSTANTLY instead
// of flashing the "not connected" UI for the one network round-trip the status fetch takes. The
// connection state changes rarely (you connect once), so a stale-then-revalidate seed is safe.
const GMAIL_STATUS_LS = "lumina:gmail-status";
type GmailStatusData = Awaited<ReturnType<typeof gmailStatus>>;

function readCachedStatus(): GmailStatusData | undefined {
  try {
    const raw = localStorage.getItem(GMAIL_STATUS_LS);
    return raw ? (JSON.parse(raw) as GmailStatusData) : undefined;
  } catch {
    return undefined;
  }
}

/** Is Gmail connected (and as which address)? Cached + shared across components. */
export function useGmailStatus() {
  const query = useQuery({
    queryKey: GMAIL_STATUS_KEY,
    queryFn: gmailStatus,
    staleTime: 30_000,
    // Paint last-known status immediately, but mark it stale (updatedAt 0) so we still revalidate on
    // mount. A genuine new user has nothing stored → initialData is undefined → query stays pending
    // and the view shows a neutral skeleton (see assistant-view.tsx), never a wrong state.
    initialData: readCachedStatus,
    initialDataUpdatedAt: 0,
  });

  // Keep the persisted copy fresh (incl. after connect/disconnect, which refetch this query).
  useEffect(() => {
    if (query.data) {
      try {
        localStorage.setItem(GMAIL_STATUS_LS, JSON.stringify(query.data));
      } catch {
        /* ignore quota / private-mode write failures */
      }
    }
  }, [query.data]);

  return query;
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
