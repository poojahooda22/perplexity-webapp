// Unit tests for the attachment composer pieces: AttachmentPreviews (render image/doc chips +
// remove → onRemove(index)), AttachButton (hidden file input, disabled at MAX_ATTACHMENTS), and
// the File → FileReader → base64 path via fileToAttachment + the hidden input's onChange.
// These are pure prop-driven components (no fetch/auth), so we render without providers.
import { describe, test, expect, mock } from "bun:test";

import { render, screen, fireEvent, waitFor, within } from "@tests/helpers/utils";
import {
  AttachButton,
  AttachmentPreviews,
  fileToAttachment,
  MAX_ATTACHMENTS,
} from "@/components/attachments";
import type { Attachment } from "@/lib/api";

// A tiny base64 payload (the literal bytes don't matter — we only assert OUR data round-trips).
const PNG_B64 = "aGVsbG8="; // "hello"
const imageAttachment: Attachment = { name: "photo.png", mediaType: "image/png", base64: PNG_B64 };
const docAttachment: Attachment = { name: "report.pdf", mediaType: "application/pdf", base64: PNG_B64 };

describe("AttachmentPreviews", () => {
  test("renders nothing when there are no attachments (empty state)", () => {
    const { container } = render(<AttachmentPreviews attachments={[]} onRemove={mock()} />);
    // Component returns null for an empty list → no chips, no remove buttons.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("renders an image chip as an <img> with the data URL and the file name", () => {
    render(<AttachmentPreviews attachments={[imageAttachment]} onRemove={mock()} />);

    expect(screen.getByText("photo.png")).toBeInTheDocument();
    const img = screen.getByRole("img", { name: "photo.png" });
    expect(img).toHaveAttribute("src", `data:image/png;base64,${PNG_B64}`);
  });

  test("renders a non-image chip without an <img> (uses the file icon) but with the name", () => {
    render(<AttachmentPreviews attachments={[docAttachment]} onRemove={mock()} />);

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    // No preview image for a PDF.
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("renders one chip per attachment with a name-scoped remove button", () => {
    render(
      <AttachmentPreviews attachments={[imageAttachment, docAttachment]} onRemove={mock()} />,
    );

    expect(screen.getByText("photo.png")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove photo.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove report.pdf" })).toBeInTheDocument();
  });

  test("clicking a chip's remove button calls onRemove with that chip's index", () => {
    const onRemove = mock();
    render(
      <AttachmentPreviews
        attachments={[imageAttachment, docAttachment]}
        onRemove={onRemove}
      />,
    );

    // Remove the SECOND chip → index 1.
    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(1);

    // And the FIRST chip → index 0.
    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    expect(onRemove).toHaveBeenCalledTimes(2);
    expect(onRemove).toHaveBeenLastCalledWith(0);
  });
});

describe("AttachButton", () => {
  test("renders the accessible attach trigger with a hidden file input", () => {
    const { container } = render(<AttachButton onAdd={mock()} />);

    // The visible affordance is a labelled trigger.
    expect(screen.getByLabelText("Attach media")).toBeInTheDocument();
    // The actual input is a multiple file input.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.multiple).toBe(true);
  });

  test("is enabled (interactive) by default", () => {
    render(<AttachButton onAdd={mock()} />);
    const label = screen.getByLabelText("Attach media");
    // Not disabled → no opacity/pointer-events-none lockout class.
    expect(label.className).not.toContain("pointer-events-none");
  });

  test("is disabled at MAX_ATTACHMENTS (pointer-events locked out)", () => {
    render(<AttachButton onAdd={mock()} disabled />);
    const label = screen.getByLabelText("Attach media");
    // happy-dom applies no CSS, so we assert the lockout class the component adds when disabled.
    expect(label.className).toContain("pointer-events-none");
    expect(label.className).toContain("opacity-50");
  });

  test("MAX_ATTACHMENTS is the documented cap (5)", () => {
    expect(MAX_ATTACHMENTS).toBe(5);
  });
});

describe("fileToAttachment (File → FileReader → base64)", () => {
  test("reads a file into the base64 Attachment shape, stripping the data-URL prefix", async () => {
    const file = new File(["hello"], "greeting.txt", { type: "text/plain" });
    const att = await fileToAttachment(file);

    expect(att.name).toBe("greeting.txt");
    expect(att.mediaType).toBe("text/plain");
    // Base64 of "hello" is "aGVsbG8=" — and there must be NO "data:...;base64," prefix left.
    expect(att.base64).toBe("aGVsbG8=");
    expect(att.base64).not.toContain("data:");
    expect(att.base64).not.toContain(",");
  });

  test("falls back to a generic mediaType when the File has no type", async () => {
    const file = new File(["x"], "blob", { type: "" });
    const att = await fileToAttachment(file);
    expect(att.mediaType).toBe("application/octet-stream");
  });
});

describe("AttachButton onChange (hidden input → onAdd with base64 attachments)", () => {
  test("selecting files reads them and forwards base64 attachments to onAdd", async () => {
    const onAdd = mock();
    const { container } = render(<AttachButton onAdd={onAdd} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const fileA = new File(["hello"], "a.txt", { type: "text/plain" });
    const fileB = new File(["world"], "b.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [fileA, fileB] } });

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    const added = onAdd.mock.calls[0][0] as Attachment[];
    expect(added.map((a) => a.name)).toEqual(["a.txt", "b.txt"]);
    expect(added[0].base64).toBe("aGVsbG8="); // "hello"
    expect(added[1].base64).toBe("d29ybGQ="); // "world"
    expect(added[0].base64).not.toContain("data:");
  });

  test("caps a large selection at MAX_ATTACHMENTS files", async () => {
    const onAdd = mock();
    const { container } = render(<AttachButton onAdd={onAdd} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const files = Array.from(
      { length: MAX_ATTACHMENTS + 3 },
      (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }),
    );
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    const added = onAdd.mock.calls[0][0] as Attachment[];
    expect(added.length).toBe(MAX_ATTACHMENTS);
  });

  test("does not call onAdd when nothing is selected", async () => {
    const onAdd = mock();
    const { container } = render(<AttachButton onAdd={onAdd} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [] } });

    // Give the async onChange a chance to run; it should never fire onAdd for an empty selection.
    await new Promise((r) => setTimeout(r, 0));
    expect(onAdd).not.toHaveBeenCalled();
  });
});
