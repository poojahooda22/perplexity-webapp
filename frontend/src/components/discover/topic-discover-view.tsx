import { useState } from "react";
import { ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";

import type { Attachment } from "@/lib/api";

// The Academic home: a search box (runs the normal web-search answer flow, like Discover) and
// two category carousels — "Trending Topics" and "Research Papers". Every card fires a generated
// search via onAsk (papers are a library — you browse by category, not a flat paper dump).

/* ── Reusable arrows + center-dots carousel (matches the Discover carousel) ── */
function CarouselButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="inline-flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {children}
    </button>
  );
}

function Carousel<T>({
  items,
  perPage,
  render,
}: {
  items: T[];
  perPage: number;
  render: (item: T) => React.ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const safePage = Math.min(page, pages - 1);
  const visible = items.slice(safePage * perPage, safePage * perPage + perPage);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map(render)}
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <CarouselButton onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} label="Previous">
            <ChevronLeft className="size-4" />
          </CarouselButton>
          <div className="flex items-center gap-1.5">
            {Array.from({ length: pages }).map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                aria-label={`Page ${i + 1}`}
                className={
                  "h-1.5 rounded-full transition-all " +
                  (i === safePage ? "w-4 bg-foreground/70" : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70")
                }
              />
            ))}
          </div>
          <CarouselButton onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={safePage === pages - 1} label="Next">
            <ChevronRight className="size-4" />
          </CarouselButton>
        </div>
      )}
    </div>
  );
}

type Category = { label: string; image: string };

// Public-domain artwork (Wikimedia, verified-stable) — creative, free, themed per category.
const wiki = (file: string) => `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=1000`;

function CategoryCard({ item, onClick }: { item: Category; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative block h-44 overflow-hidden rounded-2xl text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <img
        src={item.image}
        alt=""
        loading="lazy"
        className="absolute inset-0 size-full object-cover transition-transform duration-300 group-hover:scale-105"
      />
      <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
      <span className="absolute bottom-3 left-4 right-4 text-base font-semibold leading-tight text-white drop-shadow-sm">
        {item.label}
      </span>
    </button>
  );
}

// Trending Topics — broad areas (classical paintings).
const TRENDING: Category[] = [
  { label: "Technology and computer science", image: wiki("Vassily_Kandinsky,_1913_-_Color_Study,_Squares_with_Concentric_Circles.jpg") },
  { label: "Political science and social science", image: wiki("Pieter_Bruegel_the_Elder_-_The_Tower_of_Babel_(Vienna)_-_Google_Art_Project_-_edited.jpg") },
  { label: "Finance", image: wiki("Quentin_Massys_001.jpg") },
  { label: "Health and wellness", image: wiki("Rembrandt_-_The_Anatomy_Lesson_of_Dr_Nicolaes_Tulp.jpg") },
  { label: "Arts and culture", image: wiki("Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg") },
  { label: "Natural sciences", image: wiki("Great_Wave_off_Kanagawa2.jpg") },
];

// Research Papers — specific (tech-leaning) research areas. Browse the library by category;
// clicking a card showcases that area's latest papers via the search flow.
const RESEARCH: Category[] = [
  { label: "Artificial Intelligence", image: wiki("Cajal_actx_inter.jpg") },
  { label: "Large Language Models", image: wiki("Rosetta_Stone.JPG") },
  { label: "Computer Science", image: wiki("Eniac.jpg") },
  { label: "Robotics", image: wiki("Maillardet's_automaton.jpg") },
  { label: "Quantum Computing", image: wiki("Solvay_conference_1927.jpg") },
  { label: "Cybersecurity", image: wiki("EnigmaMachineLabeled.jpg") },
];

const CHIPS = ["Health", "Law", "Technology", "Science", "Humanities"];

export function AcademicView({
  onAsk,
}: {
  onAsk: (query: string, attachments: Attachment[]) => void;
}) {
  const year = new Date().getFullYear();
  const [value, setValue] = useState("");

  const ask = (q: string) => {
    const t = q.trim();
    if (t) onAsk(t, []);
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-9 px-4 pb-16 pt-24">
        {/* Title */}
        <h1 className="text-center text-4xl font-light tracking-tight sm:text-5xl">
          <span className="text-foreground">lumina</span>{" "}
          <span className="text-muted-foreground">academic</span>
        </h1>

        {/* Search box → runs the normal web-search answer flow */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(value);
            setValue("");
          }}
          className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card shadow-sm transition-shadow focus-within:border-ring/60"
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
            placeholder="Explore academic papers, journals, and more"
            className="block field-sizing-content max-h-[30vh] min-h-[28px] w-full resize-none overflow-y-auto bg-transparent px-5 pt-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <div className="flex items-center justify-end px-3 pb-3 pt-2">
            <button
              type="submit"
              aria-label="Search"
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

        {/* Quick category chips */}
        <div className="flex flex-wrap justify-center gap-2">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => ask(`Latest ${c.toLowerCase()} research breakthroughs and notable papers in ${year}`)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Search className="size-3.5" />
              {c}
            </button>
          ))}
        </div>

        {/* Trending Topics — arrows + dots carousel */}
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">Trending Topics</h2>
          <Carousel
            items={TRENDING}
            perPage={3}
            render={(t) => (
              <CategoryCard
                key={t.label}
                item={t}
                onClick={() => ask(`What are the latest research trends in ${t.label.toLowerCase()} in ${year}?`)}
              />
            )}
          />
        </section>

        {/* Research Papers — browse the library by category (same carousel) */}
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">Research Papers</h2>
          <Carousel
            items={RESEARCH}
            perPage={3}
            render={(r) => (
              <CategoryCard
                key={r.label}
                item={r}
                onClick={() => ask(`Show the latest research papers and key findings in ${r.label} (${year}), with links.`)}
              />
            )}
          />
        </section>
      </div>
    </div>
  );
}
