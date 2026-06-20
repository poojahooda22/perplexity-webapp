import { useRef, useState } from "react";
import {
  Activity,
  ArrowUp,
  CalendarCheck,
  Dumbbell,
  FlaskConical,
  Loader2,
  Moon,
  Plus,
  Salad,
  Upload,
} from "lucide-react";

import { ArticleCard, Carousel } from "@/components/discover/discover-parts";
import { MicButton } from "@/components/mic-button";
import { fileToAttachment } from "@/components/attachments";
import { useHealthDiscover } from "@/hooks/use-discover";
import type { Market } from "@/lib/discover-api";
import type { Attachment } from "@/lib/api";

// Lumina Health: a health search box, "Health Workflows" category cards (each opens the AI chat
// scoped to that workflow), a right rail (connectors / file upload / bio), and a Discover carousel
// of the latest health news. Not a diagnostic tool — guidance only.

type Workflow = { icon: typeof Activity; label: string; desc: string; prompt: string };

const WORKFLOWS: Workflow[] = [
  { icon: Activity, label: "Health review", desc: "A comprehensive view of your health with actionable insights", prompt: "Act as my health reviewer. Give me a comprehensive overview of how to assess my overall health and the key biomarkers worth tracking." },
  { icon: Salad, label: "Nutrition planner", desc: "A meal plan aligned with your goals", prompt: "Act as a nutrition planner. Help me build a healthy meal plan — ask me about my goals, preferences, and any restrictions first." },
  { icon: FlaskConical, label: "Lab results interpreter", desc: "A clear analysis of your lab results", prompt: "Act as a lab results interpreter. Explain how to read common blood-test and lab markers in plain language, and what's typically normal vs. flagged." },
  { icon: CalendarCheck, label: "Visit prep assistant", desc: "A briefing for your next appointment", prompt: "Act as a visit prep assistant. Help me prepare the right questions and notes for my next doctor's appointment." },
  { icon: Dumbbell, label: "Fitness coach", desc: "A workout plan tailored to your goals", prompt: "Act as my fitness coach. Help me build a workout plan — ask me about my goals, fitness level, and available equipment first." },
  { icon: Moon, label: "Sleep & recovery coach", desc: "Better sleep and recovery", prompt: "Act as a sleep and recovery coach. Give me evidence-based ways to improve my sleep quality and recovery, and ask what's affecting my sleep." },
];

function MarketToggle({ market, onChange }: { market: Market; onChange: (m: Market) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5 text-xs">
      {(["us", "in"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={
            "rounded-full px-3 py-1 font-medium transition-colors focus-visible:outline-none " +
            (market === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")
          }
        >
          {m === "us" ? "Global" : "India"}
        </button>
      ))}
    </div>
  );
}

export function HealthView({
  onAsk,
}: {
  onAsk: (query: string, attachments: Attachment[]) => void;
}) {
  const [market, setMarket] = useState<Market>("us");
  const [value, setValue] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const { data, isLoading, isError } = useHealthDiscover(market);
  const articles = data?.articles ?? [];

  const ask = (q: string, attachments: Attachment[] = []) => {
    const t = q.trim();
    if (t) onAsk(t, attachments);
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const att = await fileToAttachment(file);
    ask(
      "Summarize this health report and explain the key findings in plain language. Note anything I should discuss with a doctor.",
      [att],
    );
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-7 px-4 pb-16 pt-10">
        {/* Header */}
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Lumina Health</h1>
          <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Beta
          </span>
        </div>

        {/* Search box → runs the normal web-search answer flow */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(value);
            setValue("");
          }}
          className="w-full rounded-2xl border border-border bg-card shadow-sm transition-shadow focus-within:border-ring/60"
        >
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(value);
                setValue("");
              }
            }}
            rows={1}
            placeholder="Ask anything about health…"
            className="block field-sizing-content max-h-[30vh] min-h-[28px] w-full resize-none overflow-y-auto bg-transparent px-5 pt-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <div className="flex items-center justify-end gap-1.5 px-3 pb-3 pt-2">
            <MicButton />
            <button
              type="submit"
              aria-label="Ask"
              disabled={!value.trim()}
              className={
                "inline-flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
                (value.trim()
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-secondary text-muted-foreground")
              }
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </form>

        {/* Workflows (left) + right rail */}
        <div className="grid gap-5 lg:grid-cols-3">
          <section className="space-y-3 lg:col-span-2">
            <div>
              <h2 className="text-base font-semibold text-foreground">Health Workflows</h2>
              <p className="text-sm text-muted-foreground">Guided assistants — pick one to start a focused chat.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {WORKFLOWS.map((w) => (
                <button
                  key={w.label}
                  type="button"
                  onClick={() => ask(w.prompt)}
                  className="group flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-ring/50"
                >
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-secondary text-foreground">
                    <w.icon className="size-4" />
                  </span>
                  <span className="text-sm font-semibold text-foreground">{w.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{w.desc}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Right rail */}
          <aside className="space-y-4">
            <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">Connectors</h3>
                <Plus className="size-4 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">Connect health providers and wearables (coming soon).</p>
            </div>

            <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold text-foreground">Health files</h3>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Upload className="size-4" />
                Upload lab results & documents
              </button>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="image/*,application/pdf,.txt,.csv,.doc,.docx"
                onChange={onUpload}
              />
              <p className="text-xs text-muted-foreground">We'll summarize the report and flag anything to discuss with a doctor.</p>
            </div>
          </aside>
        </div>

        {/* Discover — latest health news carousel */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-0.5">
              <h2 className="text-base font-semibold text-foreground">Discover</h2>
              <p className="text-sm text-muted-foreground">{data?.provenance?.attribution ?? "Latest health news"}</p>
            </div>
            <MarketToggle market={market} onChange={setMarket} />
          </div>

          {isLoading || isError ? (
            <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
              {isLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Loading…
                </>
              ) : (
                <span className="text-rose-500">Couldn’t load — the source may be rate-limited or down.</span>
              )}
            </div>
          ) : articles.length > 0 ? (
            <Carousel items={articles} perPage={3} render={(a) => <ArticleCard key={a.id} a={a} />} />
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-card/50 px-4 py-6 text-sm text-muted-foreground">
              No health news right now — check back shortly.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}