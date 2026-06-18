import { cn } from "@/lib/utils";

/** Perplexity-style 8-point asterisk mark. Uses currentColor so it themes automatically. */
export function PerplexityMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      className={cn("size-5", className)}
      aria-hidden="true"
    >
      <path d="M12 2.5v19M2.5 12h19M5.4 5.4l13.2 13.2M18.6 5.4 5.4 18.6" />
    </svg>
  );
}

/** Lowercase wordmark, approximating the Perplexity hero logotype. */
export function PerplexityWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-sans text-5xl font-light lowercase tracking-tight text-foreground sm:text-6xl",
        className,
      )}
    >
      perplexity
    </span>
  );
}
