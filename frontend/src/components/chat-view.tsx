import { useState } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { parseStream, type ImageResult, type Source } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ChatTab = "answer" | "links" | "images";

export interface Turn {
  id: string;
  question: string;
  full: string;
  status: "streaming" | "done" | "error";
  error?: string;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      out.push(item);
    }
  }
  return out;
}

function faviconUrl(url: string): string {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return "";
  }
}

// Turn inline [1] / [2] citations into clickable links to the matching source.
function linkifyCitations(markdown: string, sources: Source[]): string {
  if (sources.length === 0) return markdown;
  return markdown.replace(/\[(\d+)\](?!\()/g, (match, num: string) => {
    const src = sources[Number(num) - 1];
    return src ? `[[${num}]](${src.url})` : match;
  });
}

function Markdown({ content, sources }: { content: string; sources: Source[] }) {
  return (
    <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-a:font-medium prose-a:text-foreground prose-a:underline-offset-2 prose-table:text-sm prose-th:text-left prose-img:rounded-lg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {linkifyCitations(content, sources)}
      </ReactMarkdown>
    </div>
  );
}

export function ChatView({
  turns,
  activeTab,
  onFollowUp,
  busy,
}: {
  turns: Turn[];
  activeTab: ChatTab;
  onFollowUp: (query: string) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onFollowUp(trimmed);
    setValue("");
  }

  const parsedTurns = turns.map((turn) => ({ turn, parsed: parseStream(turn.full) }));
  const sources = dedupeByUrl(parsedTurns.flatMap((t) => t.parsed.sources));
  const images = dedupeByUrl(parsedTurns.flatMap((t) => t.parsed.images));

  const lastTurn = turns[turns.length - 1];
  const followUps =
    lastTurn?.status === "done"
      ? (parsedTurns[parsedTurns.length - 1]?.parsed.followUps ?? [])
      : [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8">
          {activeTab === "answer" && (
            <AnswerTab parsedTurns={parsedTurns} followUps={followUps} onFollowUp={onFollowUp} busy={busy} />
          )}
          {activeTab === "links" && <LinksTab sources={sources} query={lastTurn?.question} />}
          {activeTab === "images" && <ImagesTab images={images} />}
        </div>
      </div>

      {/* Follow-up composer (always visible) */}
      <div className=" px-4 py-3">
        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-border bg-card px-4 py-2 focus-within:border-ring/60"
        >
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask a follow-up…"
            className="block field-sizing-content max-h-[30vh] min-h-[24px] flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Send follow-up"
            disabled={!value.trim() || busy}
            className={cn(
              "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              value.trim() && !busy
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-secondary text-muted-foreground",
            )}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}

function AnswerTab({
  parsedTurns,
  followUps,
  onFollowUp,
  busy,
}: {
  parsedTurns: { turn: Turn; parsed: ReturnType<typeof parseStream> }[];
  followUps: string[];
  onFollowUp: (query: string) => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-10">
      {parsedTurns.map(({ turn, parsed }) => {
        const showSpinner = turn.status === "streaming" && !parsed.answer;
        return (
          <article key={turn.id} className="space-y-4">
            {/* User query — right-aligned bubble */}
            {turn.question && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2 text-[15px] text-foreground">
                  {turn.question}
                </div>
              </div>
            )}

            {turn.status === "error" ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {turn.error ?? "Something went wrong."}
              </p>
            ) : showSpinner ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Searching the web…
              </div>
            ) : (
              <>
                {parsed.sources.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {parsed.sources.slice(0, 5).map((s, i) => (
                      <a
                        key={`${turn.id}-src-${i}`}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-[14rem] items-center gap-1.5 truncate rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <span className="text-muted-foreground/70">{i + 1}.</span>
                        <span className="truncate">{s.title?.trim() || hostname(s.url)}</span>
                      </a>
                    ))}
                  </div>
                )}

                <div className="text-foreground/90">
                  <Markdown content={parsed.answer} sources={parsed.sources} />
                  {turn.status === "streaming" && (
                    <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/60 align-middle" />
                  )}
                </div>
              </>
            )}
          </article>
        );
      })}

      {followUps.length > 0 && (
        <div className="space-y-2 border-t border-border/60 pt-4">
          <div className="text-xs font-medium text-muted-foreground">Related</div>
          <div className="flex flex-col gap-1.5">
            {followUps.map((q, i) => (
              <button
                key={`followup-${i}`}
                type="button"
                onClick={() => onFollowUp(q)}
                disabled={busy}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-sm text-foreground/90 transition-colors hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {q}
                <ArrowUp className="size-4 rotate-45 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LinksTab({ sources, query }: { sources: Source[]; query?: string }) {
  if (sources.length === 0) return <Empty label="No links for this conversation yet." />;
  return (
    <div>
      {query && (
        <p className="mb-3 px-2 text-sm text-muted-foreground">
          Search results for: <span className="text-foreground">{query}</span>
        </p>
      )}
      <ol className="space-y-1">
        {sources.map((s, i) => (
          <li key={`${s.url}-${i}`}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent/50"
            >
              <img
                src={faviconUrl(s.url)}
                alt=""
                className="mt-0.5 size-5 shrink-0 rounded"
                onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="truncate font-medium text-foreground/90">{hostname(s.url)}</span>
                  <span className="text-muted-foreground opacity-50">· {i + 1}</span>
                </div>
                <div className="truncate text-xs text-muted-foreground">{s.url}</div>
                <div className="mt-1 truncate text-sm font-medium text-foreground group-hover:underline">
                  {s.title?.trim() || hostname(s.url)}
                </div>
                {/* line-clamp needs display:-webkit-box — do NOT add `block` (it overrides it) */}
                {s.content && (
                  <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {s.content}
                  </p>
                )}
              </div>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ImagesTab({ images }: { images: ImageResult[] }) {
  if (images.length === 0) return <Empty label="No images for this search." />;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {images.map((img, i) => (
        <a
          key={`${img.url}-${i}`}
          href={img.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group block overflow-hidden rounded-xl border border-border bg-card"
        >
          <img
            src={img.url}
            alt={img.description ?? ""}
            loading="lazy"
            onError={(e) => {
              const anchor = e.currentTarget.closest("a");
              if (anchor) anchor.style.display = "none";
            }}
            className="aspect-video w-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        </a>
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="py-12 text-center text-sm text-muted-foreground">{label}</p>;
}
