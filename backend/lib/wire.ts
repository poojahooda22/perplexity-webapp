// ─────────────────────────────────────────────────────────────────────────
// Wire-format helpers — the exact <SOURCES>/<IMAGES>/<ANSWER>/<FOLLOW_UPS> protocol
// the frontend parses. WRITE side (sourcesImagesTail) is appended to the stream + persisted;
// READ side (stripWireTail) removes the UI blobs before re-feeding history to the LLM.
// Plus the multimodal attachment + numbered-context builders. All PURE — no DB, no network.
// ─────────────────────────────────────────────────────────────────────────

/** A user-attached image/document as decoded from the request body. */
export type RawAttachment = { name?: string; mediaType?: string; base64?: string };

/** AI-SDK multimodal content parts. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType: string }
  | { type: "file"; data: string; mediaType: string; filename?: string };

// The sources + images wire blocks as ONE string — written to the live stream AND persisted
// with the assistant message, so reloading a conversation keeps its links + images.
export function sourcesImagesTail(sources: unknown, images: unknown): string {
  return (
    `\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n` +
    `\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`
  );
}

// Remove the <SOURCES>…<SOURCES> / <IMAGES>…<IMAGES> wire blocks (closing tag == opening token)
// and the model's own <ANSWER>/<FOLLOW_UPS> output markup, so follow-ups don't replay UI blobs
// as LLM context. Keeps the answer prose.
export function stripWireTail(content: string): string {
  return content
    .replace(/\n?<SOURCES>[\s\S]*?<SOURCES>\n?/g, "")
    .replace(/\n?<IMAGES>[\s\S]*?<IMAGES>\n?/g, "")
    .replace(/<FOLLOW_UPS>[\s\S]*?<\/FOLLOW_UPS>/g, "") // suggested-questions block — drop entirely
    .replace(/<\/?ANSWER>/g, "") // unwrap the answer, keep its text
    .trim();
}

// Turn user-attached images/documents into AI-SDK multimodal content parts. Images become
// `image` parts; everything else (PDFs, docs) becomes `file` parts. Skips entries without base64.
export function buildAttachmentParts(input: unknown): ContentPart[] {
  if (!Array.isArray(input)) return [];
  return (input as RawAttachment[])
    .filter((a) => a && typeof a.base64 === "string" && a.base64.length > 0)
    .map((a) => {
      const mediaType = a.mediaType || "application/octet-stream";
      return mediaType.startsWith("image/")
        ? { type: "image" as const, image: a.base64!, mediaType }
        : { type: "file" as const, data: a.base64!, mediaType, filename: a.name };
    });
}

// Render search results as a numbered, citeable context block so the model's inline [n]
// citations line up with the sources list the client shows. Content is capped per source.
export function formatSearchContext(
  results: Array<{ title?: string; url: string; content?: string }>,
): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title ?? r.url}\nURL: ${r.url}\n${(r.content ?? "").slice(0, 1200)}`)
    .join("\n\n");
}