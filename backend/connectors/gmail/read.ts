// ─────────────────────────────────────────────────────────────────────────
// Gmail READ — inbox reads for the assistant (requires the gmail.readonly scope).
//   • getUnreadCount — the UNREAD label's messagesUnread (one cheap call)
//   • listMessages   — recent message ids, then metadata (From/Subject/Date + snippet) per id
//   • getMessage     — one message's full decoded text body, for reading/summarizing
//
// Gmail base64url-encodes message bodies and nests them in a MIME part tree; extractBody walks
// it preferring text/plain, falling back to de-tagged text/html.
// ─────────────────────────────────────────────────────────────────────────
import { gmailFetch } from "./client.js";

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: Header[]; mimeType?: string; body?: { data?: string }; parts?: Part[] };
}

const decode = (data?: string): string =>
  data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";

function header(m: GmailMessage, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// Depth-first search for the first part of a given mime type that carries body data.
function findPart(node: Part, mime: string): string | null {
  if (node.mimeType === mime && node.body?.data) return node.body.data;
  for (const p of node.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

function extractBody(payload: GmailMessage["payload"]): string {
  if (!payload) return "";
  const plain = findPart(payload as Part, "text/plain");
  if (plain) return decode(plain);
  const html = findPart(payload as Part, "text/html");
  if (html) {
    return decode(html)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}
export interface EmailDetail extends EmailSummary {
  body: string;
}

function summarize(m: GmailMessage): EmailSummary {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, "From"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    snippet: m.snippet ?? "",
    unread: (m.labelIds ?? []).includes("UNREAD"),
  };
}

/** Number of unread messages (from the UNREAD system label). */
export async function getUnreadCount(userId: string): Promise<number> {
  const res = await gmailFetch(userId, "/labels/UNREAD");
  if (!res.ok) throw new Error(`unread count failed (${res.status})`);
  const j = (await res.json()) as { messagesUnread?: number };
  return j.messagesUnread ?? 0;
}

/** Recent emails (newest first), optionally filtered by a Gmail search query. */
export async function listMessages(
  userId: string,
  opts: { query?: string; max?: number },
): Promise<EmailSummary[]> {
  const max = Math.min(Math.max(opts.max ?? 5, 1), 20);
  const params = new URLSearchParams({ maxResults: String(max) });
  if (opts.query?.trim()) params.set("q", opts.query.trim());

  const listRes = await gmailFetch(userId, `/messages?${params.toString()}`);
  if (!listRes.ok) throw new Error(`list failed (${listRes.status})`);
  const list = (await listRes.json()) as { messages?: { id: string }[] };
  const ids = (list.messages ?? []).map((m) => m.id);

  // Metadata-only per message (cheap): headers + snippet, no bodies.
  return Promise.all(
    ids.map(async (id) => {
      const r = await gmailFetch(
        userId,
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      if (!r.ok) throw new Error(`message meta failed (${r.status})`);
      return summarize((await r.json()) as GmailMessage);
    }),
  );
}

/** One message's full content (decoded body capped to keep the prompt small). */
export async function getMessage(userId: string, id: string): Promise<EmailDetail> {
  const res = await gmailFetch(userId, `/messages/${id}?format=full`);
  if (!res.ok) throw new Error(`get message failed (${res.status})`);
  const m = (await res.json()) as GmailMessage;
  return { ...summarize(m), body: extractBody(m.payload).slice(0, 8000) };
}
