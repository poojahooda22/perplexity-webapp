import { describe, expect, test } from "bun:test";

import {
  buildAttachmentParts,
  formatSearchContext,
  sourcesImagesTail,
  stripWireTail,
} from "../../lib/wire";

describe("sourcesImagesTail", () => {
  test("emits the exact <SOURCES>/<IMAGES> wire blocks", () => {
    const tail = sourcesImagesTail([{ url: "u" }], []);
    expect(tail).toContain('\n<SOURCES>\n[{"url":"u"}]\n<SOURCES>\n');
    expect(tail).toContain("\n<IMAGES>\n[]\n<IMAGES>\n");
  });
});

describe("stripWireTail", () => {
  test("round-trips: removes what sourcesImagesTail appended", () => {
    const body = "answer text" + sourcesImagesTail([{ url: "u" }], [{ url: "i" }]);
    expect(stripWireTail(body)).toBe("answer text");
  });

  test("unwraps <ANSWER> and drops the <FOLLOW_UPS> block", () => {
    const s = "<ANSWER>hello</ANSWER>\n<FOLLOW_UPS>\n<question>q</question>\n</FOLLOW_UPS>";
    expect(stripWireTail(s)).toBe("hello");
  });
});

describe("buildAttachmentParts", () => {
  test("returns [] for non-arrays", () => {
    expect(buildAttachmentParts(undefined)).toEqual([]);
    expect(buildAttachmentParts(null)).toEqual([]);
    expect(buildAttachmentParts("x")).toEqual([]);
  });

  test("skips entries without base64", () => {
    expect(buildAttachmentParts([{ name: "a", mediaType: "image/png" }])).toEqual([]);
  });

  test("maps images → image parts and everything else → file parts", () => {
    expect(
      buildAttachmentParts([
        { name: "p.png", mediaType: "image/png", base64: "AAA" },
        { name: "d.pdf", mediaType: "application/pdf", base64: "BBB" },
        { base64: "CCC" }, // no mediaType → octet-stream → file
      ]),
    ).toEqual([
      { type: "image", image: "AAA", mediaType: "image/png" },
      { type: "file", data: "BBB", mediaType: "application/pdf", filename: "d.pdf" },
      { type: "file", data: "CCC", mediaType: "application/octet-stream", filename: undefined },
    ]);
  });
});

describe("formatSearchContext", () => {
  test("numbers results from 1 and includes the url", () => {
    const ctx = formatSearchContext([{ title: "T", url: "https://x", content: "body" }]);
    expect(ctx).toContain("[1] T");
    expect(ctx).toContain("URL: https://x");
    expect(ctx).toContain("body");
  });

  test("falls back to url when no title and caps content at 1200 chars", () => {
    const ctx = formatSearchContext([{ url: "https://only", content: "z".repeat(2000) }]);
    expect(ctx).toContain("[1] https://only");
    expect(ctx).not.toContain("z".repeat(1201));
  });
});