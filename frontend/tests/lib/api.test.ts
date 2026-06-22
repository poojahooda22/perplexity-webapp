// Unit tests for the core API client: the PURE stream parser (answer / follow-ups / sources /
// images out of the running buffer, with mid-stream safety) and the authenticated fetch wrappers
// (conversations + Gmail connector) — correct method/URL, the Authorization token, JSON parsing,
// and error throwing on non-2xx. (Archetype: API module.)
import { describe, expect, test } from "bun:test";

import { mockFetch, __setSession, makeUser } from "@tests/helpers/utils";
import {
  parseStream,
  fetchConversations,
  renameConversation,
  deleteConversation,
  gmailStartUrl,
  gmailSend,
  gmailDisconnect,
} from "@/lib/api";

describe("parseStream (pure)", () => {
  test("pulls the answer out of <ANSWER>…</ANSWER>", () => {
    const full = "<ANSWER>Lumina is a research app.</ANSWER>";
    const parsed = parseStream(full);
    expect(parsed.answer).toBe("Lumina is a research app.");
    expect(parsed.followUps).toEqual([]);
    expect(parsed.sources).toEqual([]);
    expect(parsed.images).toEqual([]);
  });

  test("extracts follow-ups from <question>…</question> blocks", () => {
    const full =
      "<ANSWER>Here is the answer.</ANSWER>\n" +
      "<FOLLOW_UPS>\n" +
      "<question>What about pricing?</question>\n" +
      "<question>How does it scale?</question>\n" +
      "</FOLLOW_UPS>";
    const parsed = parseStream(full);
    // The <question> blocks are stripped from the answer body…
    expect(parsed.answer).toBe("Here is the answer.");
    // …and surfaced as discrete follow-ups.
    expect(parsed.followUps).toEqual(["What about pricing?", "How does it scale?"]);
  });

  test("parses sources from the \\n<SOURCES>\\n<json>\\n<SOURCES>\\n block", () => {
    const sources = [
      { title: "Source One", url: "https://example.com/1", content: "snippet" },
      { url: "https://example.com/2" },
    ];
    const full =
      "<ANSWER>Grounded answer.</ANSWER>" +
      `\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n`;
    const parsed = parseStream(full);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources[0]?.url).toBe("https://example.com/1");
    expect(parsed.sources[0]?.title).toBe("Source One");
    expect(parsed.sources[1]?.url).toBe("https://example.com/2");
    // The SOURCES block must not bleed into the answer text.
    expect(parsed.answer).toBe("Grounded answer.");
  });

  test("parses images from the \\n<IMAGES>\\n<json>\\n<IMAGES>\\n block", () => {
    const images = [
      { url: "https://img.example/a.png", description: "a diagram" },
      { url: "https://img.example/b.png" },
    ];
    const full =
      "<ANSWER>Look at these.</ANSWER>" +
      `\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`;
    const parsed = parseStream(full);
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0]?.url).toBe("https://img.example/a.png");
    expect(parsed.images[0]?.description).toBe("a diagram");
    expect(parsed.answer).toBe("Look at these.");
  });

  test("parses a full buffer with answer + follow-ups + sources + images together", () => {
    const sources = [{ url: "https://example.com/s" }];
    const images = [{ url: "https://example.com/i.png" }];
    const full =
      "<ANSWER>Complete answer.</ANSWER>\n" +
      "<FOLLOW_UPS>\n<question>Tell me more?</question>\n</FOLLOW_UPS>" +
      `\n<SOURCES>\n${JSON.stringify(sources)}\n<SOURCES>\n` +
      `\n<IMAGES>\n${JSON.stringify(images)}\n<IMAGES>\n`;
    const parsed = parseStream(full);
    expect(parsed.answer).toBe("Complete answer.");
    expect(parsed.followUps).toEqual(["Tell me more?"]);
    expect(parsed.sources).toEqual(sources);
    expect(parsed.images).toEqual(images);
  });

  test("returns the answer mid-stream before its closing </ANSWER> tag arrives", () => {
    // The parser is called on every chunk; an open <ANSWER> with no close should still surface text.
    const full = "<ANSWER>Streaming partial text";
    const parsed = parseStream(full);
    expect(parsed.answer).toBe("Streaming partial text");
  });

  test("returns [] for an incomplete SOURCES block (mid-stream safety)", () => {
    // Closing delimiter not yet streamed in → the regex doesn't match → no sources.
    const full =
      "<ANSWER>Answer.</ANSWER>" +
      `\n<SOURCES>\n${JSON.stringify([{ url: "https://x" }])}`;
    const parsed = parseStream(full);
    expect(parsed.sources).toEqual([]);
  });

  test("returns [] when the SOURCES block contains unparseable JSON", () => {
    // Block is delimited but the inner JSON is still half-streamed / malformed.
    const full =
      "<ANSWER>Answer.</ANSWER>" +
      "\n<SOURCES>\n[{ \"url\": \"https://x\"\n<SOURCES>\n";
    const parsed = parseStream(full);
    expect(parsed.sources).toEqual([]);
  });

  test("returns [] for images when the IMAGES JSON is incomplete", () => {
    const full =
      "<ANSWER>Answer.</ANSWER>" +
      "\n<IMAGES>\n[{ \"url\": \n<IMAGES>\n";
    const parsed = parseStream(full);
    expect(parsed.images).toEqual([]);
  });

  test("falls back to text before <FOLLOW_UPS> when no <ANSWER> tag is present", () => {
    const full = "Bare answer text.\n<FOLLOW_UPS>\n<question>Next?</question>\n</FOLLOW_UPS>";
    const parsed = parseStream(full);
    expect(parsed.answer).toBe("Bare answer text.");
    expect(parsed.followUps).toEqual(["Next?"]);
  });
});

describe("fetchConversations", () => {
  test("returns [] when the payload omits `conversations`", async () => {
    __setSession(makeUser());
    mockFetch({ "/conversations": { json: {} } });
    const result = await fetchConversations();
    expect(result).toEqual([]);
  });

  test("returns the conversations array and sends the Authorization token", async () => {
    __setSession(makeUser());
    const conversations = [{ id: "c1", title: "First chat", slug: "first-chat" }];
    const { calls } = mockFetch({ "/conversations": { json: { conversations } } });
    const result = await fetchConversations();
    expect(result).toEqual(conversations);
    expect(calls[0]?.headers.get("authorization")).toBe("test-token");
  });

  test("throws on a non-ok response", async () => {
    __setSession(makeUser());
    mockFetch({ "/conversations": { status: 500 } });
    await expect(fetchConversations()).rejects.toThrow("Failed to load conversations (500)");
  });
});

describe("renameConversation", () => {
  test("PATCHes the conversation with the new title and auth token", async () => {
    __setSession(makeUser());
    const { calls } = mockFetch({ "PATCH /conversations/abc": { json: {} } });
    await renameConversation("abc", "Renamed");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.pathname).toBe("/conversations/abc");
    expect(calls[0]?.body).toEqual({ title: "Renamed" });
    expect(calls[0]?.headers.get("authorization")).toBe("test-token");
  });

  test("throws when the rename fails", async () => {
    __setSession(makeUser());
    mockFetch({ "PATCH /conversations/abc": { status: 403 } });
    await expect(renameConversation("abc", "Renamed")).rejects.toThrow("Rename failed (403)");
  });
});

describe("deleteConversation", () => {
  test("DELETEs the conversation with the auth token", async () => {
    __setSession(makeUser());
    const { calls } = mockFetch({ "DELETE /conversations/xyz": { json: {} } });
    await deleteConversation("xyz");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.pathname).toBe("/conversations/xyz");
    expect(calls[0]?.headers.get("authorization")).toBe("test-token");
  });

  test("throws when the delete fails", async () => {
    __setSession(makeUser());
    mockFetch({ "DELETE /conversations/xyz": { status: 404 } });
    await expect(deleteConversation("xyz")).rejects.toThrow("Delete failed (404)");
  });
});

describe("gmailStartUrl", () => {
  test("returns the consent url from the payload", async () => {
    __setSession(makeUser());
    const { calls } = mockFetch({
      "/connectors/gmail/start": { json: { url: "https://accounts.google.com/o/oauth2/consent" } },
    });
    const url = await gmailStartUrl();
    expect(url).toBe("https://accounts.google.com/o/oauth2/consent");
    expect(calls[0]?.headers.get("authorization")).toBe("test-token");
  });

  test("throws on a non-ok response", async () => {
    __setSession(makeUser());
    mockFetch({ "/connectors/gmail/start": { status: 500 } });
    await expect(gmailStartUrl()).rejects.toThrow("Could not start Gmail connect (500)");
  });
});

describe("gmailSend", () => {
  const input = { to: "a@b.com", subject: "Hi", body: "Hello there" };

  test("returns {id, threadId} on a 200 and POSTs the email body", async () => {
    __setSession(makeUser());
    const { calls } = mockFetch({
      "POST /connectors/gmail/send": { json: { id: "msg-1", threadId: "thread-1" } },
    });
    const result = await gmailSend(input);
    expect(result).toEqual({ id: "msg-1", threadId: "thread-1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual(input);
    expect(calls[0]?.headers.get("authorization")).toBe("test-token");
  });

  test("throws data.error on a non-ok response", async () => {
    __setSession(makeUser());
    mockFetch({
      "POST /connectors/gmail/send": { status: 400, json: { error: "Recipient address is invalid" } },
    });
    await expect(gmailSend(input)).rejects.toThrow("Recipient address is invalid");
  });
});

describe("gmailDisconnect", () => {
  test("DELETEs the gmail connector with the auth token", async () => {
    __setSession(makeUser());
    const { calls } = mockFetch({ "DELETE /connectors/gmail": { json: {} } });
    await gmailDisconnect();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.pathname).toBe("/connectors/gmail");
    expect(calls[0]?.headers.get("authorization")).toBe("test-token");
  });

  test("throws when the disconnect fails", async () => {
    __setSession(makeUser());
    mockFetch({ "DELETE /connectors/gmail": { status: 500 } });
    await expect(gmailDisconnect()).rejects.toThrow("Disconnect failed (500)");
  });
});
