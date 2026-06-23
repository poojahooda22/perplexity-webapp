import { useRef, useState } from "react";
import type { ComponentType } from "react";
import { useNavigate } from "react-router";
import { ArrowUp, Box, Check, Mail, MessageSquare, Plug, Plus, Sparkles, Workflow } from "lucide-react";

import { ModelMenu } from "@/components/model-menu";
import { MicButton } from "@/components/mic-button";
import { AttachButton, AttachmentPreviews, MAX_ATTACHMENTS } from "@/components/attachments";
import { useGmailStatus } from "@/hooks/use-connectors";
import type { Attachment } from "@/lib/api";
import { cn } from "@/lib/utils";

// The Assistant tab is NOT the Discover hero. It's the home for the connected-tools agent:
// ask about your connectors (Gmail today; Outlook/Slack/GitHub next), see connection status,
// and jump to managing/automating them. The composer routes to the "assistant" vertical
// (Dashboard maps section → vertical), so submissions hit the Gmail tool agent.

type IconType = ComponentType<{ className?: string }>;
interface ConnectorChip {
  id: string;
  name: string;
  icon: IconType;
  tint: string;
}

const CONNECTORS: ConnectorChip[] = [
  { id: "gmail", name: "Gmail", icon: Mail, tint: "bg-red-500/10 text-red-600 dark:text-red-400" },
  { id: "outlook", name: "Outlook", icon: Mail, tint: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  { id: "slack", name: "Slack", icon: MessageSquare, tint: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  { id: "github", name: "GitHub", icon: Box, tint: "bg-foreground/10 text-foreground" },
];

// Suggestions that work with the read-only Gmail tools we ship today.
const GMAIL_PROMPTS = [
  "How many unread emails do I have?",
  "Summarize my latest email",
  "What are my emails from this week about?",
  "Who emailed me most recently?",
];

export function AssistantView({
  onSubmit,
  model,
  onModelChange,
}: {
  onSubmit: (query: string, attachments: Attachment[]) => void;
  model: string;
  onModelChange: (id: string) => void;
}) {
  const navigate = useNavigate();
  const status = useGmailStatus();
  const gmailConnected = !!status.data?.connected;
  // Distinguish "still loading" from "definitively not connected": while the first status fetch is
  // in flight `status.data` is undefined, so a naive `!data?.connected` would render the new-user
  // "Connect Gmail" state at a user who IS connected (the ~2s flash). `useGmailStatus` seeds from a
  // persisted copy (use-connectors.ts), so returning connected users skip this entirely.
  const statusResolved = !status.isPending;

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
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10">
      <div className="mb-8 flex flex-col items-center text-center">
        {/* <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="size-5" />
        </div> */}
        <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Ask across your connected apps — read and act on your email
        </p>
      </div>

      {/* Composer → routes to the "assistant" (connected-tools) vertical */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
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
          placeholder={
            gmailConnected ? "Ask about your email, or anything…" : "Ask about your connectors…"
          }
          className="block field-sizing-content max-h-[30vh] min-h-[28px] w-full resize-none overflow-y-auto bg-transparent px-5 pt-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <AttachmentPreviews
          attachments={attachments}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
          className="px-5 pt-3"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-2">
          <AttachButton
            onAdd={(added) => setAttachments((prev) => [...prev, ...added].slice(0, MAX_ATTACHMENTS))}
            disabled={attachments.length >= MAX_ATTACHMENTS}
          />
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

      {/* Connectors strip — status + jump to manage/connect */}
      <div className="mt-6 flex w-full max-w-2xl flex-wrap items-center justify-center gap-2">
        {CONNECTORS.map((c) => {
          const Icon = c.icon;
          const connected = c.id === "gmail" && gmailConnected;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => navigate("/connectors")}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <span className={cn("flex size-5 items-center justify-center rounded", c.tint)}>
                <Icon className="size-3" />
              </span>
              <span className="text-foreground/90">{c.name}</span>
              {connected ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <Check className="size-3" />
                  Connected
                </span>
              ) : c.id === "gmail" ? (
                // Don't assert "Connect" until status resolves, or it flashes for connected users.
                statusResolved ? (
                  <span className="text-xs text-muted-foreground">Connect</span>
                ) : (
                  <span className="h-3 w-12 animate-pulse rounded bg-muted" aria-hidden />
                )
              ) : (
                <span className="text-xs text-muted-foreground">Soon</span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => navigate("/connectors")}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plug className="size-3.5" />
          Manage
        </button>
      </div>

      {/* Suggestions (when Gmail is connected) or a connect CTA (when not) */}
      <div className="mt-6 w-full max-w-2xl">
        {gmailConnected ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {GMAIL_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onSubmit(p, [])}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Mail className="size-4" />
                {p}
              </button>
            ))}
          </div>
        ) : statusResolved ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Connect Gmail to ask about your inbox right here.
            </p>
            <button
              type="button"
              onClick={() => navigate("/connectors")}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="size-4" />
              Connect Gmail
            </button>
          </div>
        ) : (
          // Status not yet known — neutral skeleton, never the new-user connect CTA.
          <div className="flex flex-wrap items-center justify-center gap-2" aria-hidden>
            {GMAIL_PROMPTS.map((p) => (
              <div
                key={p}
                className="h-[42px] w-44 animate-pulse rounded-lg border border-border bg-muted/40"
              />
            ))}
          </div>
        )}
      </div>

      {/* Automations teaser (scheduling lands later) */}
      <button
        type="button"
        onClick={() => navigate("/connectors")}
        className="mt-6 inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Workflow className="size-3.5" />
        Automations & scheduled tasks — coming soon
      </button>
    </div>
  );
}
