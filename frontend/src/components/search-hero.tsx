import { useRef, useState } from "react";
import type { ComponentType } from "react";
import { ArrowUp, Briefcase, FileText, Map as MapIcon, Presentation } from "lucide-react";

import { LuminaWordmark } from "@/components/brand";
import { ModelMenu } from "@/components/model-menu";
import { MicButton } from "@/components/mic-button";
import { AttachButton, AttachmentPreviews, MAX_ATTACHMENTS } from "@/components/attachments";
import type { Attachment } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Suggestion {
  icon: ComponentType<{ className?: string }>;
  label: string;
  prompt: string;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: FileText, label: "Create a report", prompt: "Create a detailed research report on " },
  { icon: MapIcon, label: "Plan a trip", prompt: "Plan a 5-day trip to " },
  { icon: Presentation, label: "Create a slide deck", prompt: "Create a slide deck outline about " },
  { icon: Briefcase, label: "Run my job search", prompt: "Find recent software engineering jobs for " },
];

export function SearchHero({
  onSubmit,
  model,
  onModelChange,
}: {
  onSubmit: (query: string, attachments: Attachment[]) => void;
  model: string;
  onModelChange: (id: string) => void;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed, attachments);
    setValue("");
    setAttachments([]);
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 pb-24">
      <LuminaWordmark className="mb-10" />

      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="w-full max-w-2xl rounded-2xl border border-border bg-card shadow-sm transition-shadow focus-within:border-ring/60"
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Ask anything…"
          className="block field-sizing-content max-h-[30vh] min-h-[28px] w-full resize-none overflow-y-auto bg-transparent px-5 pt-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
        />

        <AttachmentPreviews
          attachments={attachments}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
          className="px-5 pt-3"
        />

        <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-2">
          <div className="flex items-center gap-1.5">
            <AttachButton
              onAdd={(added) => setAttachments((prev) => [...prev, ...added].slice(0, MAX_ATTACHMENTS))}
              disabled={attachments.length >= MAX_ATTACHMENTS}
            />
          </div>

          <div className="flex items-center gap-1.5">
            <ModelMenu value={model} onChange={onModelChange} />
            <MicButton />
            <button
              type="submit"
              aria-label="Submit"
              disabled={!value.trim()}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                value.trim()
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-secondary text-muted-foreground",
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </form>

      {/* Suggestion chips */}
      <div className="mt-6 flex max-w-2xl flex-wrap items-center justify-center gap-2">
        {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              setValue(prompt);
              textareaRef.current?.focus();
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
