import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { DiscoverArticle } from "@/lib/discover-api";

// Shared building blocks for the Discover-style pages (Academic, Health): the arrows+dots
// carousel, the image category card, and the news article card.

export type Category = { label: string; image: string };

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function faviconFromUrl(url: string): string {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return "";
  }
}

// Public-domain artwork (Wikimedia, verified-stable) for category cards.
export const wiki = (file: string) => `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=1000`;

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

export function Carousel<T>({
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{visible.map(render)}</div>
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

export function CategoryCard({ item, onClick }: { item: Category; onClick: () => void }) {
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

export function ArticleCard({ a }: { a: DiscoverArticle }) {
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-ring/50"
    >
      {a.image && (
        <div className="aspect-video w-full overflow-hidden bg-secondary">
          <img
            src={a.image}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <img
            src={faviconFromUrl(a.url)}
            alt=""
            className="size-3.5 rounded"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
          <span className="truncate font-medium text-foreground/80">{a.source}</span>
          <span className="shrink-0">· {timeAgo(a.publishedAt)}</span>
        </div>
        <div className="line-clamp-3 text-sm font-medium leading-snug text-foreground">{a.title}</div>
      </div>
    </a>
  );
}