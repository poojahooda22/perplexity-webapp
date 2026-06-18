import { supabase } from "./supabase";
import { BACKEND_URL } from "./config";

export interface ConversationSummary {
  id: string;
  title: string | null;
  slug: string;
}

export interface Source {
  title?: string;
  url: string;
  content?: string;
}

export interface ImageResult {
  url: string;
  description?: string;
}

export interface ParsedAnswer {
  answer: string;
  followUps: string[];
  sources: Source[];
  images: ImageResult[];
}

async function authHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? "";
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const token = await authHeader();
  const res = await fetch(`${BACKEND_URL}/conversations`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`Failed to load conversations (${res.status})`);
  const data = (await res.json()) as { conversations?: ConversationSummary[] };
  return data.conversations ?? [];
}

export interface ConversationMessage {
  id: number;
  role: "user" | "Assistant";
  content: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  const token = await authHeader();
  const res = await fetch(`${BACKEND_URL}/conversations/${id}`, {
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`Failed to load conversation (${res.status})`);
  const data = (await res.json()) as { conversation: ConversationDetail };
  return data.conversation;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const token = await authHeader();
  const res = await fetch(`${BACKEND_URL}/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Rename failed (${res.status})`);
}

export async function deleteConversation(id: string): Promise<void> {
  const token = await authHeader();
  const res = await fetch(`${BACKEND_URL}/conversations/${id}`, {
    method: "DELETE",
    headers: { Authorization: token },
  });
  if (!res.ok) throw new Error(`Delete failed (${res.status})`);
}

export interface AskResult {
  conversationId: string | null;
  full: string;
}

interface StreamOpts {
  signal?: AbortSignal;
  onChunk: (full: string) => void;
  /** AI Gateway model id, e.g. "openai/gpt-4o". Server allowlists + defaults it. */
  model?: string;
}

async function streamPost(
  path: string,
  body: Record<string, unknown>,
  opts: StreamOpts,
): Promise<AskResult> {
  const token = await authHeader();
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `Request failed (${res.status})`);
  }

  const conversationId = res.headers.get("x-conversation-id");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
    opts.onChunk(full);
  }

  return { conversationId, full };
}

/** First turn of a conversation — hits /perplexity_ask. */
export function streamAsk(
  query: string,
  opts: StreamOpts & { conversationId?: string },
): Promise<AskResult> {
  return streamPost(
    "/perplexity_ask",
    { query, conversationId: opts.conversationId, model: opts.model },
    opts,
  );
}

/** Subsequent turns — hits /perplexity_ask/follow_up with the full history server-side. */
export function streamFollowUp(
  conversationId: string,
  query: string,
  opts: StreamOpts,
): Promise<AskResult> {
  return streamPost("/perplexity_ask/follow_up", { conversationId, query, model: opts.model }, opts);
}

const SOURCES_RE = /\n<SOURCES>\n([\s\S]*?)\n<SOURCES>\n/;
const IMAGES_RE = /\n<IMAGES>\n([\s\S]*?)\n<IMAGES>\n/;

function parseJsonArray<T>(raw: string | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.trim());
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return []; // block still streaming in — ignore until complete
  }
}

/**
 * The backend streams: `<answer text>` then `\n<SOURCES>\n<json>\n<SOURCES>\n`
 * then `\n<IMAGES>\n<json>\n<IMAGES>\n`. The answer text follows the system prompt's
 * `<ANSWER>` / `<FOLLOW_UPS>` tags. Pulls a clean answer, follow-up questions, cited
 * sources, and images out of the running buffer (safe to call on every chunk).
 */
export function parseStream(full: string): ParsedAnswer {
  const sources = parseJsonArray<Source>(full.match(SOURCES_RE)?.[1]);
  const images = parseJsonArray<ImageResult>(full.match(IMAGES_RE)?.[1]);

  // Answer = everything before the first <SOURCES>/<IMAGES> block.
  const answerRegion = full.split(/\n<(?:SOURCES|IMAGES)>\n/)[0] ?? full;

  const ansMatch = answerRegion.match(/<ANSWER>([\s\S]*?)(?:<\/ANSWER>|$)/i);
  let answer = ansMatch ? (ansMatch[1] ?? "") : (answerRegion.split(/<FOLLOW_UPS>/i)[0] ?? answerRegion);
  answer = answer
    .replace(/<\/?(?:ANSWER|FOLLOW_UPS)>/gi, "")
    .replace(/<question>[\s\S]*?<\/question>/gi, "")
    .trim();

  const followUps = [...answerRegion.matchAll(/<question>([\s\S]*?)<\/question>/gi)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);

  return { answer, followUps, sources, images };
}
