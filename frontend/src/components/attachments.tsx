import { useId } from "react";
import { FileText, Paperclip, X } from "lucide-react";

import type { Attachment } from "@/lib/api";
import { cn } from "@/lib/utils";

const ACCEPT = "image/*,application/pdf,.pdf,.txt,.md,.csv,.doc,.docx";
export const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 20 * 1024 * 1024; // 20MB per file

/** Read a File into our base64 Attachment shape (strips the data-URL prefix). */
export async function fileToAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return {
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    base64: dataUrl.split(",")[1] ?? "",
  };
}

export function AttachButton({
  onAdd,
  disabled,
  className,
}: {
  onAdd: (attachments: Attachment[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <>
      <input
        id={id}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? [])
            .filter((f) => f.size <= MAX_BYTES)
            .slice(0, MAX_ATTACHMENTS);
          const added = await Promise.all(files.map(fileToAttachment));
          if (added.length) onAdd(added);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
      <label
        htmlFor={id}
        aria-label="Attach media"
        title="Attach images or documents"
        className={cn(
          "inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          disabled && "pointer-events-none opacity-50",
          className,
        )}
      >
        <Paperclip className="size-4" />
      </label>
    </>
  );
}

export function AttachmentPreviews({
  attachments,
  onRemove,
  className,
}: {
  attachments: Attachment[];
  onRemove: (index: number) => void;
  className?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {attachments.map((a, i) => {
        const isImage = a.mediaType.startsWith("image/");
        return (
          <div
            key={`${a.name}-${i}`}
            className="relative flex items-center gap-2 rounded-lg border border-border bg-background py-1 pl-1 pr-7 text-xs"
          >
            {isImage ? (
              <img
                src={`data:${a.mediaType};base64,${a.base64}`}
                alt={a.name}
                className="size-8 rounded object-cover"
              />
            ) : (
              <span className="flex size-8 items-center justify-center rounded bg-muted text-muted-foreground">
                <FileText className="size-4" />
              </span>
            )}
            <span className="max-w-[10rem] truncate text-foreground/90">{a.name}</span>
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={`Remove ${a.name}`}
              className="absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
