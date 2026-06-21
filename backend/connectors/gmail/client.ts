// ─────────────────────────────────────────────────────────────────────────
// Gmail CLIENT — the shared access-token + REST plumbing used by BOTH send.ts and read.ts.
//   • getGmailSession(userId) — a valid ~1h access token + the connected address, cached
//     in-memory per process (only calls Google's refresh endpoint on a miss). The long-lived
//     refresh token never leaves the store except to mint these.
//   • gmailFetch(userId, path, init) — an authed call to gmail/v1/users/me{path}; on a 401 it
//     drops the cache and retries once, then surfaces a typed GmailAuthError (reconnect needed).
//
// Centralizing this means the send and read paths can't drift on auth handling, and a future
// move to Upstash for the token cache is a one-file change.
// ─────────────────────────────────────────────────────────────────────────
import { refreshAccess } from "./oauth.js";
import { loadForSend } from "./store.js";

/** No Gmail connection exists for this user yet → they must run the connect flow. */
export class GmailNotConnectedError extends Error {
  constructor() {
    super("Gmail is not connected for this user.");
    this.name = "GmailNotConnectedError";
  }
}
/** The stored grant was rejected/insufficient (revoked, 7-day test expiry, missing scope) → reconnect. */
export class GmailAuthError extends Error {
  constructor(detail: string) {
    super(`Gmail authorization failed — reconnect required. ${detail}`);
    this.name = "GmailAuthError";
  }
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// userId -> { accessToken, email, exp(ms) }. 60s safety margin so we never use a token about to expire.
const session = new Map<string, { accessToken: string; email: string; exp: number }>();

export async function getGmailSession(userId: string): Promise<{ accessToken: string; email: string }> {
  const cached = session.get(userId);
  if (cached && cached.exp > Date.now() + 60_000) {
    return { accessToken: cached.accessToken, email: cached.email };
  }
  const conn = await loadForSend(userId);
  if (!conn) throw new GmailNotConnectedError();
  let tok;
  try {
    tok = await refreshAccess(conn.refreshToken);
  } catch (e) {
    throw new GmailAuthError(e instanceof Error ? e.message : String(e));
  }
  session.set(userId, {
    accessToken: tok.access_token,
    email: conn.googleEmail,
    exp: Date.now() + tok.expires_in * 1000,
  });
  return { accessToken: tok.access_token, email: conn.googleEmail };
}

/** Drop a cached session (e.g. after a 401 from the API). */
export function dropGmailSession(userId: string): void {
  session.delete(userId);
}

/**
 * Authed call to the Gmail REST API. `path` begins with "/" (e.g. "/messages/send",
 * "/labels/UNREAD"). Refreshes + retries once on 401; a persistent 401/403 becomes a
 * GmailAuthError so callers can tell the user to reconnect (e.g. missing readonly scope).
 */
export async function gmailFetch(userId: string, path: string, init?: RequestInit): Promise<Response> {
  const call = async () => {
    const { accessToken } = await getGmailSession(userId);
    return fetch(`${API}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` },
    });
  };
  let res = await call();
  if (res.status === 401) {
    dropGmailSession(userId);
    res = await call();
  }
  if (res.status === 401 || res.status === 403) {
    throw new GmailAuthError(`Gmail API rejected the request (${res.status}): ${await res.text()}`);
  }
  return res;
}
