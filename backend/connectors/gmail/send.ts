// ─────────────────────────────────────────────────────────────────────────
// Gmail SEND — assemble an RFC-2822 MIME message and POST it to messages/send. The access-token
// plumbing (refresh, cache, 401 retry) lives in client.ts and is shared with read.ts; this file
// is just "build the message + send it".
//
// Errors are re-exported from client.ts so existing importers (routes.ts) keep working unchanged.
// ─────────────────────────────────────────────────────────────────────────
import { getGmailSession, gmailFetch } from "./client.js";

export { GmailNotConnectedError, GmailAuthError } from "./client.js";

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
  // The from-address is the connected account; getGmailSession also primes the token cache.
  const { email } = await getGmailSession(p.userId);
  const raw = buildRaw({ from: email, to: p.to, subject: p.subject, body: p.body, cc: p.cc, bcc: p.bcc });

  // gmailFetch handles the bearer token, the 401 refresh-retry, and 401/403 → GmailAuthError.
  const res = await gmailFetch(p.userId, "/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`gmail send failed (${res.status}): ${await res.text()}`);

  const j = (await res.json()) as { id: string; threadId: string };
  return { id: j.id, threadId: j.threadId };
}
