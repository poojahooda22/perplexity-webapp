import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";

import {
  useCrypto,
  useDiscover,
  useIndices,
  useMarketSummary,
  usePredictions,
  useResearch,
  useStocks,
} from "@/hooks/use-finance";
import type {
  CryptoCoin,
  DiscoverArticle,
  PredictionMarket,
  Quote,
  ResearchNote,
  SummarySource,
} from "@/lib/finance-api";
import type { Attachment } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/animated-tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { AttachButton, AttachmentPreviews, MAX_ATTACHMENTS } from "@/components/attachments";
import { useLivePrices, type LiveStatus } from "@/hooks/use-live-prices";
import { cn } from "@/lib/utils";

const SUB_TABS = ["US Markets", "Crypto", "Earnings", "Research", "Predictions"] as const;
type SubTab = (typeof SUB_TABS)[number];

/* ── formatting ───────────────────────────────────────────────────────── */

const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const usd = (n: number) =>
  n >= 1
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : `$${n.toPrecision(3)}`;
const compact = (n: number) =>
  Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${num(n)}`;

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function faviconFromUrl(url: string): string {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return "";
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Ticker → domain for company logos (favicon service). Unknown tickers fall back to a badge.
const TICKER_DOMAIN: Record<string, string> = {
  GOOGL: "google.com",
  GOOG: "google.com",
  NVDA: "nvidia.com",
  TSLA: "tesla.com",
  META: "meta.com",
  AAPL: "apple.com",
  AMZN: "amazon.com",
  MSFT: "microsoft.com",
};

function CompanyLogo({ symbol }: { symbol: string }) {
  const domain = TICKER_DOMAIN[symbol];
  const [failed, setFailed] = useState(false);
  if (!domain || failed) {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-muted-foreground">
        {symbol.slice(0, 2)}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      className="size-7 shrink-0 rounded-full bg-white object-contain p-0.5"
      onError={() => setFailed(true)}
    />
  );
}

/* ── shared bits ──────────────────────────────────────────────────────── */

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) return <div className="h-10 w-full" />;
  const w = 120;
  const h = 40;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" preserveAspectRatio="none">
      <path
        d={d}
        fill="none"
        strokeWidth={1.75}
        className={up ? "stroke-emerald-500" : "stroke-rose-500"}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ChangePct({ value }: { value: number | null }) {
  if (value == null) return null;
  const up = value >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        up ? "text-emerald-500" : "text-rose-500",
      )}
    >
      {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
      {pct(value)}
    </span>
  );
}

function Section({
  title,
  attribution,
  badge,
  children,
}: {
  title: string;
  attribution?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          {badge}
        </div>
        {attribution && <span className="text-[11px] text-muted-foreground">{attribution}</span>}
      </div>
      {children}
    </section>
  );
}

/* ── S&P 500 Heatmap (Tier-1: TradingView embeddable widget) ──────────────
 * We embed TradingView's free Stock Heatmap widget instead of building our own
 * treemap yet. Why: it ships the exact Perplexity look (sectors grouped, cells
 * sized by market cap, colored by daily % change) AND the market-data display
 * license is TradingView's burden — so showing ~500 US equity quotes here does
 * NOT trigger the per-user NASDAQ/NYSE exchange-display fees a custom build would.
 * The TradingView attribution link is required by their ToS and must stay.
 * The branded, data-owned d3-hierarchy treemap is the planned Tier-2 upgrade.
 */
function Sp500Heatmap() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // React renders this subtree empty; we own it imperatively so the widget's
    // injected iframe never fights React reconciliation. Rebuild on mount,
    // tear down on unmount (handles React 19 StrictMode's double-invoke cleanly).
    el.innerHTML =
      '<div class="tradingview-widget-container__widget" style="height:calc(100% - 24px);width:100%"></div>' +
      '<div class="tradingview-widget-copyright" style="font-size:11px;line-height:24px;text-align:right">' +
      '<a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank" style="color:#9598a1">' +
      "Track all markets on TradingView</a></div>";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      dataSource: "SPX500",
      blockSize: "market_cap_basic", // rectangles sized by market cap
      blockColor: "change", // colored by daily % change (diverging red→green)
      grouping: "sector", // grouped by GICS sector, with header labels
      locale: "en",
      symbolUrl: "",
      colorTheme: "dark",
      exchanges: [],
      hasTopBar: false,
      isDataSetEnabled: false,
      isZoomEnabled: true,
      hasSymbolTooltip: true,
      isMonoSize: false,
      width: "100%",
      height: "100%",
    });
    el.appendChild(script);
    return () => {
      el.innerHTML = "";
    };
  }, []);

  return (
    <Section title="S&P 500 Heatmap" attribution="Live · via TradingView">
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div ref={containerRef} className="tradingview-widget-container h-[440px] w-full sm:h-[540px]" />
      </div>
    </Section>
  );
}

function PanelState({ loading, error }: { loading: boolean; error: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
      {loading ? (
        <>
          <Loader2 className="size-4 animate-spin" /> Loading…
        </>
      ) : error ? (
        <span className="text-rose-500">Couldn’t load — the data service may be rate-limited or down.</span>
      ) : null}
    </div>
  );
}

function NeedsKey({ what }: { what: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/50 px-4 py-6 text-sm text-muted-foreground">
      Add a free{" "}
      <a
        href="https://twelvedata.com/pricing"
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-foreground underline underline-offset-2"
      >
        Twelve Data
      </a>{" "}
      API key as <code className="rounded bg-secondary px-1">TWELVE_DATA_API_KEY</code> in{" "}
      <code className="rounded bg-secondary px-1">backend/.env</code> to load {what}.
    </div>
  );
}

/* ── cards ────────────────────────────────────────────────────────────── */

function IndexCard({ q }: { q: Quote }) {
  const up = (q.changePercent ?? 0) >= 0;
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      {/* Row 1: name ↔ % change */}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">{q.name}</span>
        <ChangePct value={q.changePercent} />
      </div>
      {/* Row 2: value ↔ abs change (left/right aligned on the same baseline) */}
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold tabular-nums text-foreground">{num(q.price)}</span>
        {q.change != null && (
          <span className={cn("text-xs tabular-nums", up ? "text-emerald-500" : "text-rose-500")}>
            {signed(q.change)}
          </span>
        )}
      </div>
      <div className="mt-3">
        <Sparkline points={q.sparkline ?? []} up={up} />
      </div>
    </div>
  );
}

function CryptoCard({ coin }: { coin: CryptoCoin }) {
  const up = (coin.change24h ?? 0) >= 0;
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2.5">
        {coin.image && <img src={coin.image} alt="" className="size-7 rounded-full" />}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{coin.name}</div>
          <div className="text-xs uppercase text-muted-foreground">{coin.symbol}</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-sm font-semibold text-foreground">{usd(coin.price)}</div>
          <ChangePct value={coin.change24h} />
        </div>
      </div>
      <div className="mt-3">
        <Sparkline points={coin.sparkline} up={up} />
      </div>
      {coin.marketCap != null && (
        <div className="mt-2 text-xs text-muted-foreground">Mkt cap ${compact(coin.marketCap)}</div>
      )}
    </div>
  );
}

function PredictionCard({ market, unit }: { market: PredictionMarket; unit?: string }) {
  const outcomes = [...market.outcomes].sort((a, b) => b.probability - a.probability).slice(0, 4);
  const volSymbol = unit === "mana" ? "Ṁ" : "$";
  return (
    <a
      href={market.url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col rounded-2xl border border-border bg-card p-4 transition-colors hover:border-ring/50"
    >
      <div className="flex items-start gap-3">
        {market.image && (
          <img src={market.image} alt="" className="size-9 shrink-0 rounded-lg object-cover" />
        )}
        <div className="text-sm font-medium leading-snug text-foreground">{market.question}</div>
      </div>
      <div className="mt-3 space-y-1.5">
        {outcomes.map((o, i) => {
          const p = Math.round(o.probability * 100);
          return (
            <div key={`${market.id}-${i}`} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate text-foreground/80">{o.label}</span>
                <span className="font-semibold text-foreground">{p}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary/70" style={{ width: `${p}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {market.volume != null && (
        <div className="mt-3 text-xs text-muted-foreground">
          {volSymbol}
          {compact(market.volume)} volume
        </div>
      )}
    </a>
  );
}

/* ── main-column sections ─────────────────────────────────────────────── */

function TopAssets() {
  const { data, isLoading, isError } = useIndices();
  return (
    <Section title="Top Assets" attribution={data?.provenance.attribution}>
      {data?.needsKey ? (
        <NeedsKey what="indices" />
      ) : isLoading || isError ? (
        <PanelState loading={isLoading} error={isError} />
      ) : data && data.items.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {data.items.map((q) => (
            <IndexCard key={q.symbol} q={q} />
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">No index data available.</p>
      )}
    </Section>
  );
}

function SourceRow({ source, index }: { source: SummarySource; index: number }) {
  return (
    <li>
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent/50"
      >
        <img
          src={faviconFromUrl(source.url)}
          alt=""
          className="mt-0.5 size-5 shrink-0 rounded"
          onError={(e) => {
            e.currentTarget.style.visibility = "hidden";
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="truncate font-medium text-foreground/90">{hostname(source.url)}</span>
            <span className="text-muted-foreground opacity-50">· {index}</span>
          </div>
          <div className="truncate text-xs text-muted-foreground">{source.url}</div>
          <div className="mt-1 text-sm font-medium text-foreground group-hover:underline">
            {source.title}
          </div>
          {source.content && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {source.content}
            </p>
          )}
        </div>
      </a>
    </li>
  );
}

function SourcesDrawer({
  open,
  onClose,
  sources,
}: {
  open: boolean;
  onClose: () => void;
  sources: SummarySource[];
}) {
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />}
      <aside
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[26rem] max-w-[90vw] flex-col border-l border-border bg-background shadow-xl transition-transform duration-200",
          open ? "translate-x-0" : "pointer-events-none translate-x-full",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">{sources.length} sources</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sources"
            className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <ol className="space-y-1">
            {sources.map((s, i) => (
              <SourceRow key={`${s.url}-${i}`} source={s} index={i + 1} />
            ))}
          </ol>
        </div>
      </aside>
    </>
  );
}

function MarketSummary() {
  const { data, isLoading, isError } = useMarketSummary();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const attribution = data ? `Updated ${timeAgo(data.updatedAt)}` : undefined;
  return (
    <Section title="Market Summary" attribution={attribution}>
      {isLoading || isError || !data?.items.length ? (
        <PanelState loading={isLoading} error={isError || (!isLoading && !data?.items.length)} />
      ) : (
        <div className="rounded-2xl border border-border bg-card px-4">
          <Accordion type="single" collapsible defaultValue="item-0">
            {data.items.map((it, i) => (
              <AccordionItem key={i} value={`item-${i}`}>
                <AccordionTrigger>{it.headline}</AccordionTrigger>
                <AccordionContent>{it.body}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
          {data.sources.length > 0 && (
            <button
              type="button"
              onClick={() => setSourcesOpen(true)}
              className="flex w-full items-center gap-2 border-t border-border/60 py-3 text-left transition-opacity hover:opacity-80 focus-visible:outline-none"
            >
              <div className="flex -space-x-1.5">
                {data.sources.slice(0, 6).map((s, i) => (
                  <img
                    key={`${s.url}-${i}`}
                    src={faviconFromUrl(s.url)}
                    alt=""
                    className="size-4 rounded-full bg-card ring-2 ring-card"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ))}
              </div>
              <span className="text-xs text-muted-foreground">{data.sources.length} sources</span>
            </button>
          )}
        </div>
      )}
      {data && (
        <SourcesDrawer open={sourcesOpen} onClose={() => setSourcesOpen(false)} sources={data.sources} />
      )}
    </Section>
  );
}

function DiscoverCard({ a }: { a: DiscoverArticle }) {
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-ring/50"
    >
      <div className="aspect-video w-full overflow-hidden bg-secondary">
        {a.image && (
          <img
            src={a.image}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
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

const DISCOVER_PER_PAGE = 3;

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

function DiscoverCarousel() {
  const { data, isLoading, isError } = useDiscover();
  const [page, setPage] = useState(0);

  const articles = data?.articles ?? [];
  const pages = Math.max(1, Math.ceil(articles.length / DISCOVER_PER_PAGE));
  const safePage = Math.min(page, pages - 1);
  const visible = articles.slice(safePage * DISCOVER_PER_PAGE, safePage * DISCOVER_PER_PAGE + DISCOVER_PER_PAGE);

  return (
    <Section title="Discover" attribution={data?.provenance.attribution}>
      {data?.needsKey ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/50 px-4 py-6 text-sm text-muted-foreground">
          Set <code className="rounded bg-secondary px-1">FINNHUB_API_KEY</code> in{" "}
          <code className="rounded bg-secondary px-1">backend/.env</code> to load news.
        </div>
      ) : isLoading || isError ? (
        <PanelState loading={isLoading} error={isError} />
      ) : articles.length > 0 ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((a) => (
              <DiscoverCard key={a.id} a={a} />
            ))}
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
                    className={cn(
                      "h-1.5 rounded-full transition-all",
                      i === safePage ? "w-4 bg-foreground/70" : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70",
                    )}
                  />
                ))}
              </div>
              <CarouselButton onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={safePage === pages - 1} label="Next">
                <ChevronRight className="size-4" />
              </CarouselButton>
            </div>
          )}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">No news right now.</p>
      )}
    </Section>
  );
}

function CryptoGrid({ status }: { status?: LiveStatus }) {
  const { data, isLoading, isError } = useCrypto();
  return (
    <Section
      title="Crypto"
      badge={<LiveBadge status={status} />}
      attribution={data?.provenance.attribution}
    >
      {isLoading || isError ? (
        <PanelState loading={isLoading} error={isError} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data?.coins.map((c) => (
            <CryptoCard key={c.id} coin={c} />
          ))}
        </div>
      )}
    </Section>
  );
}

function PredictionsGrid() {
  const { data, isLoading, isError } = usePredictions();
  return (
    <Section title="Prediction Markets" attribution={data?.provenance.attribution}>
      {isLoading || isError ? (
        <PanelState loading={isLoading} error={isError} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data?.markets.map((m) => (
            <PredictionCard key={m.id} market={m} unit={data.provenance.unit} />
          ))}
        </div>
      )}
    </Section>
  );
}

function EarningsPlaceholder() {
  return (
    <Section title="Earnings">
      <div className="rounded-2xl border border-dashed border-border bg-card/50 px-4 py-6 text-sm text-muted-foreground">
        Earnings calendar + recaps coming — from Twelve Data’s earnings endpoint and SEC EDGAR
        filings, with AI-summarized highlights.
      </div>
    </Section>
  );
}

function ResearchNoteCard({ note }: { note: ResearchNote }) {
  return (
    <article className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {note.label}
        </span>
        <span className="text-[11px] text-muted-foreground">Updated {timeAgo(note.updatedAt)}</span>
      </div>
      <h3 className="mt-2 text-base font-semibold tracking-tight text-foreground">{note.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{note.summary}</p>
      {note.keyPoints.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {note.keyPoints.map((k, i) => (
            <li key={i} className="flex gap-2 text-sm text-foreground/90">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/60" />
              <span>{k}</span>
            </li>
          ))}
        </ul>
      )}
      {note.body.length > 0 && (
        <Accordion type="single" collapsible className="mt-2">
          <AccordionItem value="body" className="border-b-0">
            <AccordionTrigger className="py-2 text-xs font-medium text-muted-foreground">
              Full analysis
            </AccordionTrigger>
            <AccordionContent className="pr-0">
              <div className="space-y-2">
                {note.body.map((p, i) => (
                  <p key={i} className="text-sm leading-relaxed text-foreground/80">
                    {p}
                  </p>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
      {note.sources.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-3">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Sources
          </span>
          {note.sources.slice(0, 6).map((s, i) => (
            <a
              key={`${s.url}-${i}`}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <img
                src={faviconFromUrl(s.url)}
                alt=""
                className="size-3.5 rounded"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
              {hostname(s.url)}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function ResearchView() {
  const { data, isLoading, isError } = useResearch();
  return (
    <Section title="Global Research">
      {isLoading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Generating research notes — first load takes a
          few seconds…
        </div>
      ) : isError || !data?.notes.length ? (
        <PanelState loading={false} error={true} />
      ) : (
        <div className="space-y-4">
          {data.notes.map((n) => (
            <ResearchNoteCard key={n.category} note={n} />
          ))}
        </div>
      )}
    </Section>
  );
}

/* ── right sidebar ────────────────────────────────────────────────────── */

function LiveBadge({ status }: { status?: LiveStatus }) {
  const label = status === "live" ? "Live" : status === "idle" ? "Idle" : "—";
  const dot =
    status === "live"
      ? "bg-emerald-500 animate-pulse"
      : status === "idle"
        ? "bg-amber-500"
        : "bg-muted-foreground/40";
  const title =
    status === "live"
      ? "Live — receiving real-time ticks"
      : status === "idle"
        ? "Connected, but no ticks right now (e.g. market closed)"
        : "Not connected";
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
    >
      <span className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

function WatchlistAside({ status }: { status?: LiveStatus }) {
  const { data, isLoading, isError } = useStocks();
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Watchlist</h3>
        <LiveBadge status={status} />
      </div>
      {data?.needsKey ? (
        <p className="text-xs text-muted-foreground">
          Add <code className="rounded bg-secondary px-1">TWELVE_DATA_API_KEY</code> to load stocks.
        </p>
      ) : isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data?.items.length ? (
        <p className="py-2 text-xs text-muted-foreground">No quotes available.</p>
      ) : (
        <div className="divide-y divide-border/60">
          {data.items.map((q) => (
            <div key={q.symbol} className="flex items-center gap-2.5 py-2">
              <CompanyLogo symbol={q.symbol} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{q.symbol}</div>
                {q.name && q.name !== q.symbol && (
                  <div className="truncate text-xs text-muted-foreground">{q.name}</div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm tabular-nums text-foreground">{usd(q.price)}</div>
                <ChangePct value={q.changePercent} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PredictionsMiniAside() {
  const { data } = usePredictions();
  const markets = data?.markets.slice(0, 3) ?? [];
  if (markets.length === 0) return null;
  const symbol = data?.provenance.unit === "mana" ? "Ṁ" : "$";
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Prediction Markets</h3>
      <div className="space-y-3">
        {markets.map((m) => {
          const top = [...m.outcomes].sort((a, b) => b.probability - a.probability)[0];
          return (
            <a key={m.id} href={m.url ?? "#"} target="_blank" rel="noopener noreferrer" className="block">
              <div className="line-clamp-2 text-xs font-medium text-foreground/90">{m.question}</div>
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                {top && (
                  <span>
                    {top.label} {Math.round(top.probability * 100)}%
                  </span>
                )}
                {m.volume != null && (
                  <span>
                    {symbol}
                    {compact(m.volume)}
                  </span>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

/* ── docked composer ──────────────────────────────────────────────────── */

function FinanceComposer({
  onAsk,
  placeholder,
}: {
  onAsk: (query: string, attachments: Attachment[]) => void;
  placeholder: string;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAsk(trimmed, attachments);
    setValue("");
    setAttachments([]);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="w-full rounded-2xl border border-border bg-card px-3 py-2 focus-within:border-ring/60"
    >
      <AttachmentPreviews
        attachments={attachments}
        onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
        className="px-1 pb-2 pt-1"
      />
      <div className="flex items-end gap-2">
        <AttachButton
          onAdd={(added) => setAttachments((prev) => [...prev, ...added].slice(0, MAX_ATTACHMENTS))}
          disabled={attachments.length >= MAX_ATTACHMENTS}
          className="mb-0.5"
        />
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
          placeholder={placeholder}
          className="block field-sizing-content max-h-[30vh] min-h-[24px] flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          type="button"
          aria-label="Voice (coming soon)"
          title="Voice — coming soon"
          className="mb-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Mic className="size-4" />
        </button>
        <button
          type="submit"
          aria-label="Ask"
          disabled={!value.trim()}
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            value.trim()
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-secondary text-muted-foreground",
          )}
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </form>
  );
}

/* ── the Finance tab ──────────────────────────────────────────────────── */

export function FinanceView({
  onAsk,
}: {
  onAsk: (query: string, attachments: Attachment[]) => void;
}) {
  const [tab, setTab] = useState<SubTab>("US Markets");
  const { stockStatus, cryptoStatus } = useLivePrices(); // Realtime subscribe + merge live ticks
  const placeholder =
    tab === "Crypto"
      ? "Ask anything about crypto…"
      : tab === "Predictions"
        ? "Ask anything about prediction markets…"
        : tab === "Earnings"
          ? "Ask anything about earnings…"
          : "Ask anything about US markets…";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-6">
          <Tabs type="underline" value={tab} onValueChange={(v) => setTab(v as SubTab)}>
            <TabsList>
              {SUB_TABS.map((t) => (
                <TabsTrigger key={t} value={t}>
                  {t}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="mt-6 flex gap-6">
            <main className="min-w-0 flex-1 space-y-8">
              {tab === "US Markets" && (
                <>
                  <TopAssets />
                  <MarketSummary />
                  <Sp500Heatmap />
                  <DiscoverCarousel />
                </>
              )}
              {tab === "Crypto" && <CryptoGrid status={cryptoStatus} />}
              {tab === "Earnings" && <EarningsPlaceholder />}
              {tab === "Research" && <ResearchView />}
              {tab === "Predictions" && <PredictionsGrid />}
            </main>

            <aside className="hidden w-72 shrink-0 space-y-6 lg:block">
              <WatchlistAside status={stockStatus} />
              <PredictionsMiniAside />
            </aside>
          </div>
        </div>
      </div>

      {/* Docked composer — aligned to the main (left) column; the sidebar column stays
          empty so the box sits exactly under the tabs/content grid (like Perplexity). */}
      <div className="py-3">
        <div className="mx-auto w-full max-w-6xl px-4">
          <div className="flex gap-6">
            <div className="min-w-0 flex-1">
              <FinanceComposer onAsk={onAsk} placeholder={placeholder} />
            </div>
            <div className="hidden w-72 shrink-0 lg:block" />
          </div>
        </div>
      </div>
    </div>
  );
}
