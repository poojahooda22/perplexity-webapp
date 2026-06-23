import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";

import {
  useBriefing,
  useScorecard,
  useCrypto,
  useCryptoIndex,
  useCryptoLeaderboard,
  useDiscover,
  useGdelt,
  useIndices,
  useMarketSummary,
  useMood,
  usePredictions,
  useRecession,
  useResearch,
  useSectors,
  useStocks,
} from "@/hooks/use-finance";
import type {
  CryptoCoin,
  CryptoIndexRange,
  DiscoverArticle,
  Market,
  PredictionMarket,
  Quote,
  ResearchNote,
  SummarySource,
} from "@/lib/finance-api";
import type { Attachment } from "@/lib/api";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { AttachButton, AttachmentPreviews, MAX_ATTACHMENTS } from "@/components/attachments";
import { useLivePrices, type LiveStatus } from "@/hooks/use-live-prices";
import { cn } from "@/lib/utils";

const SECTION_TABS = ["Insights", "Crypto", "Research", "Predictions"] as const;
type Tab = "Markets" | (typeof SECTION_TABS)[number];

/* ── formatting ───────────────────────────────────────────────────────── */

const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const usd = (n: number) =>
  n >= 1
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : `$${n.toPrecision(3)}`;
// Currency-aware money formatter (USD or INR). en-IN renders ₹ + lakh/crore grouping.
const money = (n: number, currency: "USD" | "INR" = "USD") =>
  n >= 1
    ? n.toLocaleString(currency === "INR" ? "en-IN" : "en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      })
    : `${currency === "INR" ? "₹" : "$"}${n.toPrecision(3)}`;
const compact = (n: number) =>
  Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${num(n)}`;

/* ── market switcher (US / India) ─────────────────────────────────────── */

const MARKETS_META: Record<Market, { flag: string; label: string }> = {
  us: { flag: "🇺🇸", label: "US Markets" },
  in: { flag: "🇮🇳", label: "India Markets" },
};

const MarketContext = createContext<Market>("us");
const useMarket = () => useContext(MarketContext);

// One shared, springy underline indicator. All tabs (Markets + the section tabs) render this
// with the SAME layoutId, so motion animates it between them (only the active tab mounts it).
const TAB_SPRING = { type: "spring" as const, stiffness: 400, damping: 35 };

function TabUnderline({ layoutId }: { layoutId: string }) {
  return (
    <motion.div
      layoutId={layoutId}
      className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-foreground"
      transition={TAB_SPRING}
    />
  );
}

// The "Markets" tab — behaves like a real tab (clicking it from another tab navigates to the
// Markets view, with the shared underline animating in) AND carries the US/India dropdown.
// When already active, clicking opens the US/India menu; otherwise it just navigates.
function MarketTab({
  market,
  active,
  layoutId,
  onActivate,
  onSelect,
}: {
  market: Market;
  active: boolean;
  layoutId: string;
  onActivate: () => void;
  onSelect: (m: Market) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = MARKETS_META[market];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (active) setOpen((o) => !o);
          else {
            onActivate();
            setOpen(false);
          }
        }}
        className={cn(
          "relative inline-flex h-9 items-center whitespace-nowrap px-2 text-sm font-medium transition-colors",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {active && <TabUnderline layoutId={layoutId} />}
        <span className="relative z-10 inline-flex items-center gap-1.5">
          {meta.label}
          <ChevronDown className="size-3.5" />
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-lg">
            {(Object.keys(MARKETS_META) as Market[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  onSelect(m);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent",
                  m === market ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="text-base leading-none">{MARKETS_META[m].flag}</span>
                {MARKETS_META[m].label}
                {m === market && <Check className="ml-auto size-4" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// A plain section tab (Crypto/Earnings/Research/Predictions), sharing the underline layoutId.
function SectionTab({
  label,
  active,
  layoutId,
  onClick,
}: {
  label: string;
  active: boolean;
  layoutId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex h-9 items-center whitespace-nowrap px-2 text-sm font-medium transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {active && <TabUnderline layoutId={layoutId} />}
      <span className="relative z-10">{label}</span>
    </button>
  );
}

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
  // US
  GOOGL: "google.com",
  GOOG: "google.com",
  NVDA: "nvidia.com",
  TSLA: "tesla.com",
  META: "meta.com",
  AAPL: "apple.com",
  AMZN: "amazon.com",
  MSFT: "microsoft.com",
  // India (watchlist tickers are stored without the .NS/.BO suffix)
  RELIANCE: "ril.com",
  TATATECH: "tatatechnologies.com",
  ICICIGI: "icicilombard.com",
  INFY: "infosys.com",
  TCS: "tcs.com",
  HDFCBANK: "hdfcbank.com",
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
 *
 * It is mounted via <iframe srcDoc> ON PURPOSE: TradingView's embed script runs
 * cross-origin and emits a benign "Script error." that the parent window's error
 * overlay (Bun's dev runtime / any global onerror) would otherwise surface as a
 * FATAL Runtime Error. Nesting it in our own iframe confines that error to the
 * iframe's window — the widget still renders (it creates its own iframe inside)
 * and our app stays clean. Branded d3-hierarchy treemap is the planned Tier-2.
 */
function Sp500Heatmap() {
  const isIndia = useMarket() === "in";
  const config = JSON.stringify({
    // India: Nifty 500 (~500 names, matches Perplexity's "Top 500 Heatmap"). If it renders blank
    // for "NIFTY500", swap to "NIFTY50" (confirm the exact value in TradingView's heatmap settings).
    dataSource: isIndia ? "NIFTY500" : "SPX500",
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
  const srcDoc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<style>html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}</style></head>" +
    '<body><div class="tradingview-widget-container" style="height:100%;width:100%">' +
    '<div class="tradingview-widget-container__widget" style="height:calc(100% - 24px);width:100%"></div>' +
    '<div class="tradingview-widget-copyright" style="font-size:11px;line-height:24px;text-align:right">' +
    '<a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank" style="color:#9598a1">' +
    "Track all markets on TradingView</a></div>" +
    '<script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js" async>' +
    config +
    "</scr" + "ipt></div></body></html>";

  return (
    <Section title={isIndia ? "Top 500 Heatmap" : "S&P 500 Heatmap"} attribution="Live · via TradingView">
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {/* key forces a full remount when the market switches. Mutating srcDoc on a live
            iframe doesn't reliably reload it once the embed script has run, so without a
            changing key the widget stays on the first market's heatmap (US). */}
        <iframe
          key={isIndia ? "heatmap-in" : "heatmap-us"}
          title={isIndia ? "Top 500 Heatmap" : "S&P 500 Heatmap"}
          srcDoc={srcDoc}
          loading="lazy"
          className="h-[440px] w-full border-0 sm:h-[540px]"
        />
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
  // Consistent order: "Yes" always on top, "No" always at the bottom (any other outcomes,
  // by probability, in between). Bars colored by outcome: Yes = green, No = red.
  const rank = (label: string) => {
    const l = label.trim().toLowerCase();
    return l === "yes" ? 0 : l === "no" ? 2 : 1;
  };
  const outcomeColor = (label: string) => {
    const l = label.trim().toLowerCase();
    if (l === "yes") return { bar: "bg-emerald-500", text: "text-emerald-500" };
    if (l === "no") return { bar: "bg-rose-500/70", text: "text-rose-500" };
    return { bar: "bg-primary/70", text: "text-foreground" };
  };
  const outcomes = [...market.outcomes]
    .sort((a, b) => rank(a.label) - rank(b.label) || b.probability - a.probability)
    .slice(0, 4);
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
          const c = outcomeColor(o.label);
          return (
            <div key={`${market.id}-${i}`} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate text-foreground/80">{o.label}</span>
                <span className={cn("font-semibold", c.text)}>{p}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className={cn("h-full rounded-full", c.bar)} style={{ width: `${p}%` }} />
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
  const { data, isLoading, isError } = useIndices(useMarket());
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
  const { data, isLoading, isError } = useMarketSummary(useMarket());
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
  const market = useMarket();
  const { data, isLoading, isError } = useDiscover(market);
  const [page, setPage] = useState(0);

  const articles = data?.articles ?? [];
  const pages = Math.max(1, Math.ceil(articles.length / DISCOVER_PER_PAGE));
  const safePage = Math.min(page, pages - 1);
  const visible = articles.slice(safePage * DISCOVER_PER_PAGE, safePage * DISCOVER_PER_PAGE + DISCOVER_PER_PAGE);

  return (
    <Section title="Discover" attribution={data?.provenance.attribution}>
      {data?.needsKey ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/50 px-4 py-6 text-sm text-muted-foreground">
          Set{" "}
          <code className="rounded bg-secondary px-1">
            {market === "in" ? "NEWSDATA_API_KEY" : "FINNHUB_API_KEY"}
          </code>{" "}
          in <code className="rounded bg-secondary px-1">backend/.env</code> to load news.
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

// ── Crypto leaderboard (All Exchanges, by 24h volume) ────────────────────
const LEADERBOARD_PAGE_SIZE = 10;
function CryptoLeaderboard({ status }: { status?: LiveStatus }) {
  const { data, isLoading, isError } = useCryptoLeaderboard();
  const [page, setPage] = useState(0);
  const coins = data?.coins ?? [];
  const pages = Math.max(1, Math.ceil(coins.length / LEADERBOARD_PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const start = safePage * LEADERBOARD_PAGE_SIZE;
  const visible = coins.slice(start, start + LEADERBOARD_PAGE_SIZE);
  return (
    <Section
      title="Leaderboard"
      badge={<LiveBadge status={status} />}
      attribution={data?.provenance.attribution}
    >
      <p className="-mt-1 text-xs text-muted-foreground">
        Active coins with $100M+ market cap, across all exchanges — ranked by 24h volume.
      </p>
      {isLoading || isError ? (
        <PanelState loading={isLoading} error={isError} />
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-medium">#</th>
                  <th className="px-3 py-2.5 text-left font-medium">Coin</th>
                  <th className="px-3 py-2.5 text-right font-medium">Price</th>
                  <th className="px-3 py-2.5 text-right font-medium">24h</th>
                  <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Vol 24H</th>
                  <th className="px-3 py-2.5 text-right font-medium">Market Cap</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c, i) => (
                  <tr key={c.id} className="border-b border-border/50 last:border-0 hover:bg-accent/40">
                    <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{start + i + 1}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        {c.image && <img src={c.image} alt="" className="size-5 rounded-full" />}
                        <span className="font-medium text-foreground">{c.name}</span>
                        <span className="text-xs uppercase text-muted-foreground">{c.symbol}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums text-foreground">{usd(c.price)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end">
                        <ChangePct value={c.change24h} />
                      </div>
                    </td>
                    <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                      {c.volume24h != null ? `$${compact(c.volume24h)}` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {c.marketCap != null ? `$${compact(c.marketCap)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between gap-3 pt-1">
              <CarouselButton onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} label="Previous coins">
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
              <CarouselButton onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={safePage === pages - 1} label="Next coins">
                <ChevronRight className="size-4" />
              </CarouselButton>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ── Lumina Crypto 50 — our own cap-weighted index (NOT the official Coinbase 50) ──
const INDEX_RANGES: { key: CryptoIndexRange; label: string }[] = [
  { key: "1d", label: "1D" },
  { key: "5d", label: "5D" },
  { key: "1m", label: "1M" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "1y", label: "1Y" },
];

// Per-range axis + tooltip time formatting.
function fmtAxisTime(t: number, range: CryptoIndexRange): string {
  const d = new Date(t);
  if (range === "1d") return d.toLocaleTimeString("en-US", { hour: "numeric" });
  if (range === "5d") return d.toLocaleDateString("en-US", { weekday: "short" });
  if (range === "1m" || range === "3m") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short" });
}
function fmtTooltipTime(t: number, range: CryptoIndexRange): string {
  const d = new Date(t);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (range === "1d" || range === "5d") {
    return `${date}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  }
  return date;
}

// Hand-rolled interactive area chart (no chart lib): y/x axes, split green/red fill at the base
// line, and a hover crosshair + tooltip. Width is measured so SVG units == screen px (crisp text +
// accurate hover math).
function IndexChart({ series, base, range }: { series: { t: number; v: number }[]; base: number; range: CryptoIndexRange }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId().replace(/:/g, "");
  const [w, setW] = useState(720);
  const [hi, setHi] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setW(el.clientWidth || 720);
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr && cr.width > 0) setW(cr.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 256;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const n = series.length;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = H - padT - padB;
  const vs = series.map((p) => p.v);
  const min = Math.min(...vs, base);
  const max = Math.max(...vs, base);
  const span = max - min || 1;
  const xi = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yv = (v: number) => padT + (1 - (v - min) / span) * plotH;
  const baseY = yv(base);

  if (n < 2) return <div ref={wrapRef} className="h-64 w-full rounded-xl bg-muted/30" />;

  const line = series.map((p, i) => `${i === 0 ? "M" : "L"}${xi(i).toFixed(1)},${yv(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${xi(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${padL.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const yTicks = Array.from({ length: 4 }, (_, k) => min + (k / 3) * span);
  const xCount = Math.min(6, n);
  const xTicks = Array.from({ length: xCount }, (_, k) => Math.round((k / Math.max(1, xCount - 1)) * (n - 1)));

  const onMove = (e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - padL) / plotW));
    setHi(Math.round(frac * (n - 1)));
  };

  const hp = hi != null && hi >= 0 && hi < n ? series[hi]! : null;
  const hx = hp ? xi(hi!) : 0;

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg ref={svgRef} width={w} height={H} className="block select-none" onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
        <defs>
          <clipPath id={`a-${clipId}`}><rect x={padL} y={padT} width={plotW} height={Math.max(0, baseY - padT)} /></clipPath>
          <clipPath id={`b-${clipId}`}><rect x={padL} y={baseY} width={plotW} height={Math.max(0, padT + plotH - baseY)} /></clipPath>
          <linearGradient id={`up-${clipId}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`dn-${clipId}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0" />
            <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0.28" />
          </linearGradient>
        </defs>
        {yTicks.map((v, k) => (
          <g key={`y${k}`}>
            <line x1={padL} y1={yv(v)} x2={padL + plotW} y2={yv(v)} className="stroke-border/40" strokeWidth="1" />
            <text x={padL - 6} y={yv(v) + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {span > 20 ? v.toFixed(0) : v.toFixed(1)}
            </text>
          </g>
        ))}
        {xTicks.map((idx, k) => {
          const label = fmtAxisTime(series[idx]!.t, range);
          if (k > 0 && fmtAxisTime(series[xTicks[k - 1]!]!.t, range) === label) return null;
          return (
            <text key={`x${k}`} x={xi(idx)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {label}
            </text>
          );
        })}
        <path d={area} fill={`url(#up-${clipId})`} clipPath={`url(#a-${clipId})`} />
        <path d={area} fill={`url(#dn-${clipId})`} clipPath={`url(#b-${clipId})`} />
        <line x1={padL} y1={baseY} x2={padL + plotW} y2={baseY} className="stroke-border" strokeWidth="1" strokeDasharray="4 4" />
        <path d={line} fill="none" strokeWidth="1.75" className="stroke-emerald-500" clipPath={`url(#a-${clipId})`} />
        <path d={line} fill="none" strokeWidth="1.75" className="stroke-rose-500" clipPath={`url(#b-${clipId})`} />
        {hp && (
          <g>
            <line x1={hx} y1={padT} x2={hx} y2={padT + plotH} className="stroke-foreground/30" strokeWidth="1" />
            <circle cx={hx} cy={yv(hp.v)} r="3.5" className="fill-background stroke-foreground" strokeWidth="1.5" />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-center shadow-md"
          style={{ left: Math.min(Math.max(hx, 56), w - 56), top: Math.max(2, yv(hp.v) - 50) }}
        >
          <div className="text-sm font-semibold tabular-nums text-foreground">{num(hp.v)}</div>
          <div className="text-[11px] text-muted-foreground">{fmtTooltipTime(hp.t, range)}</div>
        </div>
      )}
    </div>
  );
}

function LuminaCrypto50() {
  const [range, setRange] = useState<CryptoIndexRange>("6m");
  const { data, isLoading, isError } = useCryptoIndex(range);
  const up = (data?.changePct ?? 0) >= 0;
  return (
    <Section title="Lumina Crypto 50" attribution={data?.provenance.attribution}>
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-foreground">
                {data ? num(data.value) : "—"}
              </span>
              {data && (
                <span className={cn("text-sm font-medium tabular-nums", up ? "text-emerald-500" : "text-rose-500")}>
                  {signed(data.changeAbs)} ({pct(data.changePct ?? 0)})
                </span>
              )}
            </div>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Lumina's own cap-weighted top-50 crypto index, indexed to 100 at the start of the range — not
              the official Coinbase 50.{" "}
              <a
                href="https://www.coinbase.com/coin50"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Learn more about the Coinbase 50 Index
              </a>
            </p>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {INDEX_RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  range === r.key
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4">
          {isLoading || isError ? (
            <PanelState loading={isLoading} error={isError} />
          ) : (
            <IndexChart series={data?.series ?? []} base={data?.base ?? 100} range={range} />
          )}
        </div>
      </div>

      {data && data.standouts.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-xs font-semibold text-foreground">Standouts</h3>
          <p className="text-[11px] text-muted-foreground">Biggest 24h movers among the index constituents.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {data.standouts.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-xl border border-border bg-card p-2.5">
                {c.image && <img src={c.image} alt="" className="size-6 rounded-full" />}
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-foreground">{c.symbol}</div>
                  <div className="text-xs tabular-nums text-muted-foreground">{usd(c.price)}</div>
                </div>
                <div className="ml-auto">
                  <ChangePct value={c.change24h} />
                </div>
              </div>
            ))}
          </div>
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

/* ── Market Insights ("Pulse") — GREEN public-domain surfaces ─────────── */

// "Updated N min ago" from the payload's fetchedAt; prefixes "stale ·" honestly on degradation.
function freshness(fetchedAt?: number, stale?: boolean): string | undefined {
  if (!fetchedAt) return undefined;
  const mins = Math.floor((Date.now() - fetchedAt) / 60_000);
  const label = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)}h ago`;
  return `${stale ? "stale · " : ""}updated ${label}`;
}

function Disclaimer() {
  return (
    <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">
      Informational only — not financial advice.
    </p>
  );
}

// Per-datum provenance line: GREEN dot = our own commercial-display-clean series, AMBER = attribute/link-out.
function ProvenanceLine({ p }: { p: { source: string; commercialOk: boolean; attribution: string } }) {
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
      <span
        title={p.commercialOk ? "Public-domain / cleared for display" : "Attribution / link-out only"}
        className={cn("inline-block size-1.5 shrink-0 rounded-full", p.commercialOk ? "bg-emerald-500" : "bg-amber-500")}
      />
      <span className="truncate">{p.attribution}</span>
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", warn ? "text-rose-500" : "text-foreground")}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ── Mood gauge (CNN-Fear&Greed-style half-dial) ──
const MOOD_BANDS = [
  { from: 0, to: 25, color: "#ef4444" },
  { from: 25, to: 45, color: "#f97316" },
  { from: 45, to: 55, color: "#9ca3af" },
  { from: 55, to: 75, color: "#84cc16" },
  { from: 75, to: 100, color: "#16a34a" },
];
// Map 0..100 → a point on a top semicircle (v=0 → left, v=100 → right).
function gaugePoint(cx: number, cy: number, r: number, v: number) {
  const a = Math.PI * (1 - Math.max(0, Math.min(100, v)) / 100);
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}
function gaugeArc(cx: number, cy: number, r: number, v1: number, v2: number) {
  const p1 = gaugePoint(cx, cy, r, v1);
  const p2 = gaugePoint(cx, cy, r, v2);
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}
function Gauge({ value }: { value: number }) {
  const cx = 110;
  const cy = 110;
  const r = 88;
  const needle = gaugePoint(cx, cy, r - 16, value);
  return (
    <svg viewBox="0 0 220 124" className="w-full max-w-[260px]" role="img" aria-label={`Market mood ${value} of 100`}>
      {MOOD_BANDS.map((b) => (
        <path key={b.from} d={gaugeArc(cx, cy, r, b.from, b.to)} fill="none" stroke={b.color} strokeWidth={13} />
      ))}
      <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} className="stroke-foreground" strokeWidth={3} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={5} className="fill-foreground" />
    </svg>
  );
}
function moodColor(score: number): string {
  if (score < 25) return "text-rose-500";
  if (score < 45) return "text-orange-500";
  if (score <= 55) return "text-muted-foreground";
  if (score < 75) return "text-lime-500";
  return "text-emerald-500";
}

function MoodDial({ market }: { market: Market }) {
  const { data, isLoading, isError } = useMood(market);
  return (
    <Section title="Lumina Market Mood" attribution={data ? freshness(data.fetchedAt, data.stale) : undefined}>
      {isLoading || isError || !data ? (
        <PanelState loading={isLoading} error={isError || (!isLoading && !data)} />
      ) : (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-col items-center">
            <Gauge value={data.score} />
            <div className="-mt-0 text-center">
              <div className="text-3xl font-semibold tabular-nums text-foreground">{data.score}</div>
              <div className={cn("text-sm font-medium", moodColor(data.score))}>{data.label}</div>
            </div>
          </div>
          <div className="mt-5 space-y-2.5">
            {data.components.map((c) => (
              <div key={c.name} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-xs text-muted-foreground">{c.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full rounded-full bg-foreground/60" style={{ width: `${c.score}%` }} />
                </div>
                <span className="w-36 shrink-0 truncate text-right text-[11px] text-muted-foreground" title={c.note}>
                  {c.note}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">{data.caveat}</p>
          <ProvenanceLine p={data.provenance} />
          <Disclaimer />
        </div>
      )}
    </Section>
  );
}

function RecessionPanel() {
  const { data, isLoading, isError } = useRecession();
  return (
    <Section title="Recession Risk" attribution={data ? freshness(data.fetchedAt, data.stale) : undefined}>
      {isLoading || isError || !data ? (
        <PanelState loading={isLoading} error={isError || (!isLoading && !data)} />
      ) : (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-4xl font-semibold tabular-nums text-foreground">{data.probabilityPct}%</div>
              <div className="max-w-[16rem] text-xs text-muted-foreground">
                probability of a US recession within 12 months
              </div>
            </div>
            <div className="flex gap-5">
              <Stat
                label="10y–3m"
                value={`${data.spread10y3m > 0 ? "+" : ""}${data.spread10y3m}`}
                sub="pp"
                warn={data.curveInverted}
              />
              <Stat
                label="10y–2y"
                value={`${data.spread10y2y > 0 ? "+" : ""}${data.spread10y2y}`}
                sub="pp"
                warn={data.spread10y2y < 0}
              />
              {data.sahm && (
                <Stat
                  label="Sahm"
                  value={data.sahm.value.toFixed(2)}
                  sub={data.sahm.triggered ? "TRIGGERED" : "no trigger"}
                  warn={data.sahm.triggered}
                />
              )}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>3M {data.yields.m3.toFixed(2)}%</span>
            <span>2Y {data.yields.y2.toFixed(2)}%</span>
            <span>10Y {data.yields.y10.toFixed(2)}%</span>
            {data.sahm && (
              <span className="sm:ml-auto">
                U-3 {data.sahm.latestUnemployment}% · {data.sahm.asOf}
              </span>
            )}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">{data.caveat}</p>
          <ProvenanceLine p={data.provenance} />
        </div>
      )}
    </Section>
  );
}

function sentColor(score: number): string {
  if (score <= -15) return "text-rose-500";
  if (score < 15) return "text-muted-foreground";
  return "text-emerald-500";
}

function BuzzCard({ market }: { market: Market }) {
  const { data, isLoading, isError } = useGdelt(market);
  const toneUp = data && data.toneSeries.length >= 2
    ? data.toneSeries[data.toneSeries.length - 1]!.v >= data.toneSeries[0]!.v
    : true;
  return (
    <Section title="Bull / Bear Buzz" attribution={data ? freshness(data.fetchedAt, data.stale) : undefined}>
      {isLoading || isError || !data ? (
        <PanelState loading={isLoading} error={isError || (!isLoading && !data)} />
      ) : (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">News sentiment</div>
              <div className={cn("text-2xl font-semibold", sentColor(data.score))}>{data.label}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Buzz</div>
              <div className="text-2xl font-semibold tabular-nums text-foreground">
                {data.buzz}
                <span className="text-sm text-muted-foreground">/100</span>
              </div>
            </div>
          </div>
          <div className="mt-4">
            <div className="relative h-2 rounded-full bg-gradient-to-r from-rose-500/70 via-secondary to-emerald-500/70">
              <div
                className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground"
                style={{ left: `${(data.score + 100) / 2}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>Bearish</span>
              <span>Neutral</span>
              <span>Bullish</span>
            </div>
          </div>
          {data.toneSeries.length >= 2 && (
            <div className="mt-3">
              <Sparkline points={data.toneSeries.map((p) => p.v)} up={toneUp} />
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{data.caveat}</p>
          <ProvenanceLine p={data.provenance} />
        </div>
      )}
    </Section>
  );
}

// Renders briefing prose with inline [n] citations turned into clickable superscript source links.
function CitedText({ text, sources }: { text: string; sources: { n: number; url: string }[] }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[(\d+)\]$/);
        if (!m) return <span key={i}>{p}</span>;
        const n = Number(m[1]);
        const src = sources.find((s) => s.n === n);
        if (!src) return <sup key={i} className="text-muted-foreground">{n}</sup>;
        return (
          <a
            key={i}
            href={src.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mx-0.5 inline-flex items-center rounded bg-secondary px-1 align-super text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {n}
          </a>
        );
      })}
    </>
  );
}

function BriefBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function moodPillColor(mood: string): string {
  if (mood === "risk-on" || mood === "euphoric") return "bg-emerald-500/10 text-emerald-500";
  if (mood === "risk-off" || mood === "cautious") return "bg-rose-500/10 text-rose-500";
  return "bg-amber-500/10 text-amber-500";
}

function BriefingCard({ market }: { market: Market }) {
  const { data, isLoading, isError } = useBriefing(market);
  return (
    <Section
      title="The Lumina Tape — Daily Briefing"
      attribution={data ? freshness(data.fetchedAt, data.stale) : undefined}
    >
      {isLoading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Writing today’s briefing — first load takes a moment…
        </div>
      ) : isError || !data ? (
        <PanelState loading={false} error />
      ) : (
        <article className="space-y-5 rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                moodPillColor(data.marketTake.mood),
              )}
            >
              {data.marketTake.mood}
            </span>
            {data.mood && (
              <span className="text-[11px] text-muted-foreground">
                Mood {data.mood.score}/100 · {data.mood.label}
              </span>
            )}
            {data.recession && (
              <span className="text-[11px] text-muted-foreground">· Recession {data.recession.probabilityPct}%</span>
            )}
          </div>

          <div>
            <h3 className="text-xl font-semibold tracking-tight text-foreground">{data.marketTake.headline}</h3>
            <p className="mt-2 text-sm leading-relaxed text-foreground/80">
              <CitedText text={data.marketTake.body} sources={data.sources} />
            </p>
          </div>

          <div className="rounded-xl border border-border/70 bg-secondary/40 p-3 text-sm text-foreground/90">
            <span className="font-semibold">Bottom line — </span>
            <CitedText text={data.bottomLine} sources={data.sources} />
          </div>

          {data.levels.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {data.levels.map((l) => (
                <div key={l.asset} className="rounded-xl border border-border bg-background/40 p-3">
                  <div className="truncate text-[11px] text-muted-foreground">{l.asset}</div>
                  <div className="text-base font-semibold tabular-nums text-foreground">{num(l.level)}</div>
                  <ChangePct value={l.changePct} />
                </div>
              ))}
            </div>
          )}

          <BriefBlock title="What moved & why">
            <ul className="space-y-2.5">
              {data.whatMoved.map((w, i) => (
                <li key={i} className="text-sm">
                  <span className="font-medium text-foreground">{w.driver}. </span>
                  <span className="text-foreground/80">
                    <CitedText text={w.why} sources={data.sources} />
                  </span>
                </li>
              ))}
            </ul>
          </BriefBlock>

          <BriefBlock title="Sentiment read">
            <p className="text-sm text-foreground/80">
              <CitedText text={data.sentimentRead} sources={data.sources} />
            </p>
          </BriefBlock>

          <BriefBlock title="Catalysts to watch">
            <ul className="space-y-1.5">
              {data.catalysts.map((c, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/60" />
                  <span>
                    <span className="font-medium text-foreground">{c.event}</span> —{" "}
                    <span className="text-foreground/75">
                      <CitedText text={c.note} sources={data.sources} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </BriefBlock>

          <BriefBlock title="On investors’ minds">
            <div className="space-y-3">
              {data.onInvestorsMinds.map((q, i) => (
                <div key={i}>
                  <div className="text-sm font-medium text-foreground">{q.question}</div>
                  <p className="mt-0.5 text-sm text-foreground/75">
                    <CitedText text={q.take} sources={data.sources} />
                  </p>
                </div>
              ))}
            </div>
          </BriefBlock>

          {data.followUps.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.followUps.map((f, i) => (
                <span
                  key={i}
                  className="rounded-full border border-border bg-background/40 px-3 py-1 text-xs text-muted-foreground"
                >
                  {f}
                </span>
              ))}
            </div>
          )}

          {data.sources.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-3">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sources</span>
              {data.sources.slice(0, 8).map((s) => (
                <a
                  key={s.n}
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
                  {s.n}. {hostname(s.url)}
                </a>
              ))}
            </div>
          )}

          <ProvenanceLine p={data.provenance} />
          <Disclaimer />
        </article>
      )}
    </Section>
  );
}

function callStatusBadge(c: { status: string; correct: boolean | null }) {
  if (c.status === "open") return { label: "Open", cls: "bg-amber-500/10 text-amber-500" };
  if (c.correct === true) return { label: "Hit", cls: "bg-emerald-500/10 text-emerald-500" };
  if (c.correct === false) return { label: "Miss", cls: "bg-rose-500/10 text-rose-500" };
  return { label: c.status, cls: "bg-secondary text-muted-foreground" };
}

function ScorecardCard() {
  const { data, isLoading, isError } = useScorecard();
  return (
    <Section title="Track Record" attribution={data ? freshness(data.fetchedAt, data.stale) : undefined}>
      {isLoading || isError || !data ? (
        <PanelState loading={isLoading} error={isError || (!isLoading && !data)} />
      ) : (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              {data.summary.hitRate != null ? (
                <>
                  <div className="text-4xl font-semibold tabular-nums text-foreground">{data.summary.hitRate}%</div>
                  <div className="text-xs text-muted-foreground">
                    Market-Mood call hit rate — {data.summary.correct} of {data.summary.resolved} resolved
                  </div>
                </>
              ) : (
                <>
                  <div className="text-2xl font-semibold text-foreground">Establishing track record</div>
                  <div className="max-w-sm text-xs text-muted-foreground">
                    {data.summary.open} open call{data.summary.open === 1 ? "" : "s"} — none resolved yet. Hits and
                    misses will both appear here as the horizon passes.
                  </div>
                </>
              )}
            </div>
            {data.moodHistory.length >= 2 && (
              <div className="w-40">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Mood history</div>
                <Sparkline
                  points={data.moodHistory.map((m) => m.score)}
                  up={data.moodHistory[data.moodHistory.length - 1]!.score >= data.moodHistory[0]!.score}
                />
              </div>
            )}
          </div>

          {data.calls.length > 0 ? (
            <div className="mt-4 divide-y divide-border/60">
              {data.calls.slice(0, 8).map((c) => {
                const b = callStatusBadge(c);
                return (
                  <div key={c.id} className="flex items-start gap-3 py-2.5">
                    <span className={cn("mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", b.cls)}>
                      {b.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-foreground/90">{c.claim}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(c.madeAt).toLocaleDateString()} →{" "}
                        {c.status === "open"
                          ? `resolves ${new Date(c.resolveAt).toLocaleDateString()}`
                          : (c.notes ?? "resolved")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              No calls logged yet — the first is emitted on the next daily cycle.
            </p>
          )}

          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            Every Market-Mood call is logged <span className="font-medium text-foreground/80">before</span> the outcome
            is known and graded mechanically against the S&P 500 — hits{" "}
            <span className="font-medium text-foreground/80">and misses</span> both shown. No bank publishes its own
            miss rate.
          </p>
          <Disclaimer />
        </div>
      )}
    </Section>
  );
}

function MarketInsightsView() {
  const market = useMarket();
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        A free, AI-native read on the market — built only from public-domain data (U.S. Treasury, BLS, GDELT) plus
        cited news. Every figure is sourced and dated; nothing here is financial advice.
      </p>
      <BriefingCard market={market} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <MoodDial market={market} />
        <div className="space-y-6">
          <RecessionPanel />
          <BuzzCard market={market} />
        </div>
      </div>
      <ScorecardCard />
    </div>
  );
}

/* ── right sidebar ────────────────────────────────────────────────────── */

// US equities trade 09:30–16:00 ET, Mon–Fri. Holidays aren't accounted for, but that's
// harmless: on a holiday no ticks flow, so the badge reads "Closed" anyway — which is correct.
function isUsMarketOpenNow(): boolean {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// `idle` means "connected, but no ticks right now". For 24/7 crypto that's a rare glitch, so
// the default label is "Idle". The stock watchlist passes idleLabel="Closed" while the US
// market is shut — far clearer than a bare "Idle", and still honest (we never fake "Live").
function LiveBadge({
  status,
  idleLabel = "Idle",
  idleTitle = "Connected, but no ticks right now (e.g. market closed)",
}: {
  status?: LiveStatus;
  idleLabel?: string;
  idleTitle?: string;
}) {
  const label = status === "live" ? "Live" : status === "idle" ? idleLabel : "—";
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
        ? idleTitle
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
  const market = useMarket();
  const { data, isLoading, isError } = useStocks(market);
  // US stocks only tick during market hours; while it's shut, "Closed" is clearer than "Idle".
  // India quotes are delayed (no live worker feed), so they read "Idle" with a delayed-data note.
  const closed = market === "us" && !isUsMarketOpenNow();
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Watchlist</h3>
        <LiveBadge
          status={status}
          idleLabel={market === "us" ? (closed ? "Closed" : "Idle") : "Delayed"}
          idleTitle={
            market === "us"
              ? closed
                ? "US market is closed — showing the last close. Live ticks resume at the opening bell."
                : "Connected — waiting for the next trade."
              : "India quotes are delayed (no live feed)."
          }
        />
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
                <div className="text-sm tabular-nums text-foreground">
                  {money(q.price, data?.currency)}
                </div>
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

// Equity sectors — the 11 SPDR Select Sector ETFs as GICS-sector proxies (price + day %).
// Same shape as the Watchlist: name left, price + change right. Data via useSectors (Yahoo).
function EquitySectorsAside() {
  const market = useMarket();
  const { data, isLoading, isError } = useSectors(market);
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Equity Sectors</h3>
      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data?.items.length ? (
        <p className="py-2 text-xs text-muted-foreground">No sector data available.</p>
      ) : (
        <div className="divide-y divide-border/60">
          {data.items.map((q) => (
            <div key={q.symbol} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{q.name}</span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {market === "in" ? num(q.price) : usd(q.price)}
              </span>
              <span className="w-16 shrink-0 text-right">
                <ChangePct value={q.changePercent} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Popular Cryptocurrencies — top coins (stablecoins filtered out) from the SAME CoinGecko
// data the Crypto tab uses (useCrypto is de-duped by TanStack Query, so no extra request).
const STABLECOINS = new Set(["USDT", "USDC", "DAI", "BUSD", "TUSD", "USDE", "FDUSD", "USDS"]);

function PopularCryptoAside() {
  const { data, isLoading, isError } = useCrypto();
  const coins = (data?.coins ?? []).filter((c) => !STABLECOINS.has(c.symbol)).slice(0, 5);
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Popular Cryptocurrencies</h3>
      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : isError || coins.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">No crypto data available.</p>
      ) : (
        <div className="divide-y divide-border/60">
          {coins.map((c) => (
            <div key={c.id} className="flex items-center gap-2.5 py-2">
              <img src={c.image} alt="" className="size-7 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{c.name}</div>
                <div className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                  {c.symbol} · Crypto
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm tabular-nums text-foreground">{usd(c.price)}</div>
                <ChangePct value={c.change24h} />
              </div>
            </div>
          ))}
        </div>
      )}
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
  const [tab, setTab] = useState<Tab>("Markets");
  const [market, setMarket] = useState<Market>("us");
  const tabUnderlineId = useId();
  const { stockStatus, cryptoStatus } = useLivePrices(); // Realtime subscribe + merge live ticks
  

  return (
    <MarketContext.Provider value={market}>
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-6">
          <div className="flex items-center gap-1 border-b border-border/60">
            <MarketTab
              market={market}
              active={tab === "Markets"}
              layoutId={tabUnderlineId}
              onActivate={() => setTab("Markets")}
              onSelect={(m) => {
                setMarket(m);
                setTab("Markets");
              }}
            />
            {SECTION_TABS.map((t) => (
              <SectionTab
                key={t}
                label={t}
                active={tab === t}
                layoutId={tabUnderlineId}
                onClick={() => setTab(t)}
              />
            ))}
          </div>

          <div className="mt-6 flex gap-6">
            <main className="min-w-0 flex-1 space-y-8">
              {tab === "Insights" && <MarketInsightsView />}
              {tab === "Markets" && (
                <>
                  <TopAssets />
                  <MarketSummary />
                  <Sp500Heatmap />
                  <DiscoverCarousel />
                </>
              )}
              {tab === "Crypto" && (
                <>
                  <CryptoGrid status={cryptoStatus} />
                  <CryptoLeaderboard status={cryptoStatus} />
                  <LuminaCrypto50 />
                </>
              )}
              {tab === "Research" && <ResearchView />}
              {tab === "Predictions" && <PredictionsGrid />}
            </main>

            <aside className="hidden w-72 shrink-0 space-y-6 lg:block">
              <WatchlistAside status={stockStatus} />
              <EquitySectorsAside />
              <PopularCryptoAside />
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
              <FinanceComposer onAsk={onAsk} placeholder="Ask about finance..." />
            </div>
            <div className="hidden w-72 shrink-0 lg:block" />
          </div>
        </div>
      </div>
    </div>
    </MarketContext.Provider>
  );
}
