// ─────────────────────────────────────────────────────────────────────────
// Gmail TOOLS — the model-callable functions for the assistant agent, same shape as
// buildFinanceTools(): a per-request factory that CLOSES OVER userId. The model supplies the
// query/id but NEVER the userId — that's injected here, so a prompt-injection can't make the
// agent read another user's mailbox (confused-deputy defense).
//
// M2a ships READ tools only (safe, no confirmation). sendEmail (write, needsApproval) lands in M2b.
// Each execute is wrapped in guard() so a not-connected / expired-grant error comes back as a
// typed { error } the model can relay ("reconnect Gmail") instead of throwing mid-stream.
// ─────────────────────────────────────────────────────────────────────────
import { tool } from "ai";
import { z } from "zod";

import { GmailAuthError, GmailNotConnectedError } from "./client.js";
import { getMessage, getUnreadCount, listMessages } from "./read.js";

async function guard<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GmailNotConnectedError) {
      return { error: "Gmail isn't connected. Tell the user to connect it on the Connectors page." };
    }
    if (e instanceof GmailAuthError) {
      return {
        error:
          "Gmail access is expired or missing the read permission. Tell the user to reconnect " +
          "Gmail on the Connectors page.",
      };
    }
    return { error: e instanceof Error ? e.message : "Gmail request failed." };
  }
}

export function buildGmailTools({ userId }: { userId: string }) {
  return {
    unreadCount: tool({
      description: "Count the unread emails in the user's Gmail inbox.",
      inputSchema: z.object({}),
      execute: () => guard(async () => ({ unread: await getUnreadCount(userId) })),
    }),

    listEmails: tool({
      description:
        "List the user's recent emails (newest first) with sender, subject, date, snippet, and id. " +
        "Optionally filter with a Gmail search query, e.g. 'is:unread', 'from:name', 'newer_than:2d', " +
        "'has:attachment'. Call this first to get message ids.",
      inputSchema: z.object({
        query: z.string().optional().describe("Gmail search query, e.g. 'is:unread' or 'from:amazon'."),
        max: z.number().int().min(1).max(20).optional().describe("How many to return (default 5)."),
      }),
      execute: ({ query, max }) => guard(async () => ({ emails: await listMessages(userId, { query, max }) })),
    }),

    getEmail: tool({
      description:
        "Read one email's full content (subject, sender, date, body text) by id — for reading or " +
        "summarizing a specific message. Get the id from listEmails first.",
      inputSchema: z.object({ id: z.string().describe("The message id returned by listEmails.") }),
      execute: ({ id }) => guard(() => getMessage(userId, id)),
    }),
  };
}
