// ─────────────────────────────────────────────────────────────────────────
// Gmail SEND — the actual "send an email" action. Three steps:
//   1. sessionFor() — get a valid ACCESS token for this user. Access tokens last ~1h, so we
//      cache them in-memory per process and only call Google's refresh endpoint on a miss. The
//      long-lived REFRESH token never leaves the store except to mint these.
//   2. buildRaw()   — assemble an RFC-2822 MIME message and base64url-encode it (Gmail's `raw`).
//   3. POST users/me/messages/send — with the Bearer access token.
//
// Typed errors (GmailNotConnectedError / GmailAuthError) let the route translate failures into
// clean HTTP — "connect Gmail first" vs "reconnect, your grant expired" — instead of a 500.
//
// NOTE: the in-memory token cache is per-instance (fine for one box / local dev). On a
// multi-instance deploy each instance just refreshes once; move it to Upstash later if needed.
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
/** The stored refresh token was rejected by Google (revoked / 7-day test expiry) → reconnect. */
export class GmailAuthError extends Error {
  constructor(detail: string) {
    super(`Gmail authorization failed — reconnect required. ${detail}`);
    this.name = "GmailAuthError";
  }
}

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// userId -> { accessToken, email, exp(ms) }. 60s safety margin so we never send on a token
// that's about to expire mid-flight.
const session = new Map<string, { accessToken: string; email: string; exp: number }>();

async function sessionFor(userId: string): Promise<{ accessToken: string; email: string }> {
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

// RFC-2047 encoded-word for non-ASCII Subject lines (plain ASCII stays human-readable).
function encodeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=` : s;
}

/** Build the RFC-2822 message and base64url-encode it for Gmail's `raw` field. UTF-8 safe. */
function buildRaw(p: {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string {
  const bodyB64 = Buffer.from(p.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const lines = [
    `From: ${p.from}`,
    `To: ${p.to}`,
    ...(p.cc ? [`Cc: ${p.cc}`] : []),
    ...(p.bcc ? [`Bcc: ${p.bcc}`] : []),
    `Subject: ${encodeHeader(p.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    bodyB64,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export interface SendInput {
  userId: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

/** Send an email as the connected account. Returns Gmail's message + thread ids. */
export async function sendGmail(p: SendInput): Promise<{ id: string; threadId: string }> {
  const post = (accessToken: string, from: string) =>
    fetch(SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: buildRaw({ from, to: p.to, subject: p.subject, body: p.body, cc: p.cc, bcc: p.bcc }),
      }),
    });

  let { accessToken, email } = await sessionFor(p.userId);
  let res = await post(accessToken, email);

  // 401 = the access token was rejected. Drop the cache and mint a fresh one ONCE before failing.
  if (res.status === 401) {
    session.delete(p.userId);
    ({ accessToken, email } = await sessionFor(p.userId));
    res = await post(accessToken, email);
  }
  if (res.status === 401 || res.status === 403) {
    throw new GmailAuthError(`gmail send rejected (${res.status}): ${await res.text()}`);
  }
  if (!res.ok) throw new Error(`gmail send failed (${res.status}): ${await res.text()}`);

  const j = (await res.json()) as { id: string; threadId: string };
  return { id: j.id, threadId: j.threadId };
}
