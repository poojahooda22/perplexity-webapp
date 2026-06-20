import { Mic } from "lucide-react";

/**
 * Placeholder voice/mic button shown in every chat/search box, matching the Finance chat box.
 * Decorative for now ("coming soon") — wire to speech recognition later.
 */
export function MicButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label="Voice (coming soon)"
      title="Voice — coming soon"
      className={
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
        className
      }
    >
      <Mic className="size-4" />
    </button>
  );
}