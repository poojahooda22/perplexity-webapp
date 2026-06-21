# Finance Frontend & UI — building the FinanceView

> How the Finance **dashboard** UI is built and how a finance **chat** answer is produced and
> rendered. `lumina-` ref = THIS codebase; cite the live file before editing (line numbers drift).
> The data plumbing those cards consume (providers, cache, `Provenance`) lives in
> `lumina-finance-architecture.md` + `market-data-providers.md`; the agent that answers chat
> queries lives in `ai-sdk-finance-agent.md`; charts/heatmap deep-dive in
> `charting-and-visualization.md`. This ref is the **view layer** that ties them together.

Files:
[`frontend/src/components/finance/finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx),
[`frontend/src/hooks/use-finance.ts`](../../../../frontend/src/hooks/use-finance.ts),
[`frontend/src/lib/finance-api.ts`](../../../../frontend/src/lib/finance-api.ts),
[`frontend/src/pages/Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx),
[`frontend/src/components/layout/top-nav.tsx`](../../../../frontend/src/components/layout/top-nav.tsx),
[`frontend/src/components/chat-view.tsx`](../../../../frontend/src/components/chat-view.tsx).

---

## 1. Two surfaces, one mental model

The Finance vertical has **two** distinct UIs that are NOT the same component:

1. **The Finance dashboard** — `FinanceView`, a read-only card grid (indices, summary, heatmap,
   discover, watchlist, sectors, crypto, predictions). Pure TanStack Query reads against
   `/finance/*`. No LLM on the hot path.
2. **The finance chat answer** — when the user asks something in the docked composer, the app
   leaves `FinanceView` entirely and shows `ChatView` — the **same** chat UI Discover/Academic
   /Health use. There is no finance-specific chat renderer.

The pivot between them is owned by [`Dashboard.tsx`](../../../../frontend/src/pages/Dashboard.tsx):
`const inChat = turns.length > 0;` — once a turn exists, `ChatView` replaces the section view. The
section (`"Finance"`) only decides which `vertical` string goes to the backend; it does NOT change
the chat renderer.

```
Dashboard.tsx (render branch, in fn Dashboard)
  inChat ? <ChatView …/>
         : section === "Finance"  ? <FinanceView onAsk={handleAsk}/>
         : section === "Academic" ? <AcademicView .../>
         : section === "Health"   ? <HealthView .../>
         : <SearchHero .../>
```

---

## 2. The section tabs live in top-nav (not in FinanceView)

The top-level vertical switcher (Discover / Finance / Health / Academic / Assistant) is in
[`top-nav.tsx`](../../../../frontend/src/components/layout/top-nav.tsx) — `SECTION_TABS` +
`type Section`. It uses the shared **animated-tabs** primitive (`Tabs type="underline"` from
`@/components/ui/animated-tabs`), the same shared-`layoutId` spring indicator used for the chat
`Answer / Links / Images` tabs.

| Concern | Where |
|---|---|
| Which vertical is active (Discover/Finance/…) | `section` state in `Dashboard`, set via `TopNav onSectionChange`. |
| Sub-tabs **inside** Finance (Markets/Crypto/Research/Predictions) | local `tab` state in `FinanceView`, a **separate** animated underline (see §3). |
| Chat tabs (Answer/Links/Images) | `activeTab` in `Dashboard`, rendered by `TopNav` in `mode="chat"`. |

Do NOT confuse the two underline systems: `top-nav` uses the rare-ds `Tabs`/`TabsList`/`TabsTrigger`
components; `FinanceView` rolls its own with raw `motion.div layoutId` because the "Markets" tab is
special (it doubles as the US/India dropdown).

---

## 3. FinanceView sub-tabs + the animated underline

`FinanceView` holds two pieces of local state: `tab` (`"Markets" | "Crypto" | "Research" |
"Predictions"`) and `market` (`"us" | "in"`). The market is broadcast to every card via a tiny
`MarketContext` (`useMarket()`), so every hook call reads the active market without prop-drilling.

> **Naming gotcha:** `SECTION_TABS` in `finance-view.tsx` is `["Crypto","Research","Predictions"]`
> — the dashboard's **sub**-tabs, unrelated to the same-named `SECTION_TABS` in `top-nav.tsx`
> (the verticals). `Tab` = `"Markets" | (typeof SECTION_TABS)[number]`. There is also an
> `EarningsPlaceholder` component (stub) but Earnings is **not** currently wired into the tab row —
> the live sub-tabs are Markets / Crypto / Research / Predictions.

**The shared underline.** One `useId()` (`tabUnderlineId`) is passed as `layoutId` to every tab.
Only the **active** tab mounts `<TabUnderline layoutId={…}/>`, so motion animates the single
`motion.div` between tab positions (springy: `stiffness 400, damping 35`). Pattern:

```tsx
function TabUnderline({ layoutId }: { layoutId: string }) {
  return <motion.div layoutId={layoutId} transition={TAB_SPRING}
    className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-foreground" />;
}
// active && <TabUnderline layoutId={tabUnderlineId} />  — in EVERY tab button
```

`MarketTab` is the clever one (in fn `MarketTab`): when inactive, clicking it **navigates** to the
Markets view; when already active, clicking **opens** the US/India menu. So the "Markets" label is
both a tab and a dropdown trigger, carrying `MARKETS_META` (flag + label). The menu is a hand-rolled
popover (a `fixed inset-0` click-catcher + an absolutely-positioned list), not Radix.

**Sub-tab → content mapping** (in `FinanceView` render):
- `Markets` → `TopAssets` (indices) + `MarketSummary` + `Sp500Heatmap` + `DiscoverCarousel`.
- `Crypto` → `CryptoGrid` (gets `cryptoStatus` for the Live badge).
- `Research` → `ResearchView`.
- `Predictions` → `PredictionsGrid`.

The right `<aside>` (`hidden … lg:block w-72`) is **tab-independent** — always shows
`WatchlistAside` + `EquitySectorsAside` + `PopularCryptoAside` + `PredictionsMiniAside`.

---

## 4. TanStack hooks — `use-finance` + `finance-api`

[`finance-api.ts`](../../../../frontend/src/lib/finance-api.ts) is the typed fetch layer: a
`getJson<T>` helper over `BACKEND_URL` (throws on `!res.ok`), the response interfaces
(`QuotesPayload`, `CryptoPayload`, `PredictionsPayload`, `SummaryPayload`, `ResearchPayload`,
`DiscoverPayload`), and `marketQuery(market)` which appends `?market=in` for India (US is the
no-suffix default). Every payload carries `Provenance` ({source, commercialOk, attribution, unit?})
and optional `needsKey`/`stale`/`fetchedAt`/`currency`.

[`use-finance.ts`](../../../../frontend/src/hooks/use-finance.ts) wraps each in a `useQuery`. **The
query key + refetch cadence is the contract** — keep both columns aligned to the backend TTL:

| Hook | Query key | `refetchInterval` | Backend TTL |
|---|---|---|---|
| `useCrypto` | `["finance","crypto"]` | 30s | 30s |
| `usePredictions` | `["finance","predictions"]` | 120s | 120s |
| `useIndices(market)` | `["finance","indices",market]` | 60s | 300s |
| `useStocks(market)` | `["finance","stocks",market]` | 60s | 300s |
| `useSectors(market)` | `["finance","sectors",market]` | 300s | 300s |
| `useMarketSummary(market)` | `["finance","summary",market]` | 600s | 900s |
| `useResearch` | `["finance","research"]` | 1 800s (30m) | 21 600s (6h) |
| `useDiscover(market)` | `["finance","discover",market]` | 300s | 600s |

**Rules when adding/changing a hook:**
- **Poll no faster than the data can change.** The comment in `use-finance.ts` is the law: align the
  interval to the cache TTL so polling never out-runs the upstream. Polling faster only burns the
  vendor budget for stale results (the value can't change between cache windows).
- **The market is part of the key.** `["finance","stocks","in"]` and `…"us"` are separate caches, so
  switching the US/India dropdown doesn't show the wrong market's numbers and each is independently
  fresh. `crypto`/`predictions`/`research` are market-agnostic (single key).
- **Live ticks mutate these caches.** `useLivePrices()` (called once in `FinanceView`) merges
  Supabase Realtime ticks into the `["finance","stocks"]` and `["finance","crypto"]` TanStack caches
  — so the watchlist/crypto cards update between polls without a refetch. See
  `realtime-prices-websocket.md`. It returns `{stockStatus, cryptoStatus}` → the `LiveBadge`.

---

## 5. Freshness, stale & "needs key" states — render every honest state

The non-negotiable "state the as-of time / surface `stale` honestly" (SKILL §5) is a **UI**
obligation here. Every card resolves one of four states, in this order:

| State | Source | UI |
|---|---|---|
| **needsKey** | `data.needsKey` (backend has no vendor key) | `NeedsKey` / inline `<code>ENV</code>` hint (e.g. `TWELVE_DATA_API_KEY`, `FINNHUB_API_KEY`/`NEWSDATA_API_KEY`). **Check this BEFORE loading/error.** |
| **loading / error** | `isLoading` / `isError` | `PanelState` (spinner or "rate-limited or down" line). |
| **empty** | `!data.items.length` | a muted "No … available." line. |
| **data** | rows | the card grid. |

Freshness is shown as the section **attribution** string, NOT a separate badge component:
- Live/provider series → `attribution={data?.provenance.attribution}` (e.g. "Live · via Yahoo").
- LLM narratives → computed `Updated ${timeAgo(data.updatedAt)}` (Market Summary), or per-card
  `Updated …` on `ResearchNoteCard`.
- `timeAgo(iso)` (in `finance-view.tsx`) renders "just now / N min ago / Nh ago".
- The `LiveBadge` (Crypto / Watchlist) is the realtime indicator: `live` (green pulse) /
  `idle` (amber, "market closed") / `—` (not connected), driven by `LiveStatus` from `useLivePrices`.

> **Do NOT** render a stale provider number as if it were live, and do NOT hide the `needsKey`
> branch behind a generic error — a missing key is a fixable config message, not a failure.

---

## 6. Watchlist favicon logos (ticker → domain → Google favicon)

The Watchlist and the company logos are the one place the UI invents data the backend doesn't send:
the **logo**. There is no logo URL in `QuotesPayload` — `CompanyLogo` maps the ticker to a company
domain and pulls Google's favicon service:

```ts
const TICKER_DOMAIN: Record<string,string> = { GOOGL:"google.com", NVDA:"nvidia.com",
  TSLA:"tesla.com", … RELIANCE:"ril.com", INFY:"infosys.com", TCS:"tcs.com", … };
// CompanyLogo: domain ? <img src=`https://www.google.com/s2/favicons?domain=${domain}&sz=64`>
//                     : <span>{symbol.slice(0,2)}</span>   // 2-letter fallback badge
```

Rules:
- **India tickers are stored WITHOUT the `.NS`/`.BO` suffix** (`RELIANCE`, not `RELIANCE.NS`) — the
  map keys must match the bare symbol `QuotesPayload` returns.
- **Always wire `onError` → fallback.** The favicon can 404; `CompanyLogo` flips to the
  initials badge via `useState(failed)`. Crypto/news/source favicons instead `display:none` on error
  (`faviconFromUrl(url)` over the URL hostname). Pick the right fallback per surface.
- New ticker in `DEFAULT_WATCHLIST`? Add it to `TICKER_DOMAIN` or it shows initials.
- This is the **same** favicon trick `chat-view.tsx` uses (`faviconUrl`) and the Discover/source
  rows — one mechanism, several call sites.

---

## 7. The Radix accordion (Summary / Research) + its keyframes

Market Summary and the "Full analysis" of a Research note collapse behind the shared Radix accordion
([`components/ui/accordion.tsx`](../../../../frontend/src/components/ui/accordion.tsx)). Usage:

```tsx
<Accordion type="single" collapsible defaultValue="item-0">
  {data.items.map((it,i) => (
    <AccordionItem key={i} value={`item-${i}`}>
      <AccordionTrigger>{it.headline}</AccordionTrigger>
      <AccordionContent>{it.body}</AccordionContent>
    </AccordionItem>
  ))}
</Accordion>
```

The expand/collapse animation is **CSS keyframes in
[`index.css`](../../../../frontend/src/index.css)**, not motion: `@keyframes accordion-down/up`
animate `height: 0 ↔ var(--radix-accordion-content-height)` (Radix sets that CSS var), bound via the
`.acc-content[data-state="open"|"closed"]` classes that `AccordionContent` carries. So:
- The animation needs `overflow-hidden` on the content (it's in the component) — keep it.
- The chevron rotate is `[&[data-state=open]>svg]:rotate-180` on the trigger.
- Honors `@media (prefers-reduced-motion)` globally (the index.css reset zeroes animations).

If a new collapsible section feels janky, the cause is almost always a missing `.acc-content` class
or `overflow-hidden`, not a JS bug.

---

## 8. The docked composer → `handleAsk` → finance agent → ChatView

This is the spine of the chat flow. The composer is `FinanceComposer` (docked at the bottom of
`FinanceView`, aligned to the main column so it sits under the content grid). It owns
its own `value` + `attachments`, supports `AttachButton`/`AttachmentPreviews` and Enter-to-submit
(Shift+Enter = newline), and on submit calls the `onAsk(query, attachments)` prop — nothing more.

The flow end to end:

```
FinanceComposer.submit()
  → onAsk(query, attachments)                       // prop from FinanceView
  → Dashboard.handleAsk(query, attachments)         // Dashboard.tsx
       setConversationId(null); setActiveTab("answer");
       runTurn(query, fresh=true, attachments)
  → runTurn picks vertical from sectionRef.current:
       "Finance"  → "finance"   (tool-calling agent)
       "Assistant"→ "assistant"
       else       → "discover"  (web search)
  → streamAsk(query, { onChunk, model, attachments, vertical:"finance" })
       POST /perplexity_ask  { vertical:"finance", … }   (lib/api.ts)
  → SSE stream → onChunk(full) updates the live Turn
  → inChat (turns.length>0) flips Dashboard to <ChatView/>   ← composer view is gone
```

Key points to get right:
- **`handleAsk` always starts a fresh thread** (`setConversationId(null)`, `fresh=true`). Follow-ups
  go through `handleFollowUp` → `streamFollowUp` from inside `ChatView`'s own composer.
- **The vertical is read from a ref** (`sectionRef.current`), not the closure, so the async stream
  callback sees the live section without re-binding `runTurn`.
- **Finance threads persist + replay like any other** — same `conversations` list, same
  `handleSelectConversation`. The only difference is server-side routing on `vertical`.
- The composer's `Mic` button is a **placeholder** ("Voice — coming soon"); don't wire STT here
  without the mic plumbing `chat-view.tsx`'s `MicButton` uses.

---

## 9. A finance answer renders through the SAME chat-view

Once `inChat`, [`ChatView`](../../../../frontend/src/components/chat-view.tsx) renders the answer —
**there is no finance-specific renderer.** It works because the finance agent emits the identical
wire protocol as Discover (SKILL: same `<ANSWER>`/`<FOLLOW_UPS>` protocol, `financeWebSearch`
assigns global `[n]`):

- `parseStream(turn.full)` (in `lib/api.ts`) pulls `answer` from `<ANSWER>…</ANSWER>` (or everything
  before `<FOLLOW_UPS>`), the cited `sources[]` from the `\n<SOURCES>\n<json>\n<SOURCES>\n` tail, and
  the `followUps[]` — **the finance agent's `<SOURCES>` accumulator feeds this exact parser.**
- `Markdown` → `linkifyCitations(content, sources)` rewrites inline `[1]`/`[2]` into clickable links
  to `sources[n-1].url`. This is why the finance agent must hand the model **global** `[n]` numbers
  (see `ai-sdk-finance-agent.md` §2) — otherwise the citations point at the wrong source.
- The `Answer / Links / Images` chat tabs, the source chips (top 5), the streaming caret, the
  "Related" follow-up buttons, the right-aligned user bubble — all free, all shared.

**Implication for the agent side:** to make finance answers render correctly you change the
**backend** (`FINANCE_PERSONA` output protocol + `financeWebSearch` global `[n]`), never `ChatView`.
A finance answer that renders wrong (no citations, raw `<ANSWER>` tags) is a backend protocol bug.

---

## 10. Card component map (where each thing lives in finance-view.tsx)

| Component | Renders | Hook | Notes |
|---|---|---|---|
| `TopAssets` | indices grid (`IndexCard`) | `useIndices(market)` | Yahoo values + `Sparkline` (inline SVG). |
| `MarketSummary` | LLM summary accordion + sources strip → `SourcesDrawer` | `useMarketSummary` | `timeAgo(updatedAt)`; favicon source pile. |
| `Sp500Heatmap` | TradingView widget in `<iframe srcDoc>` | none | India = NIFTY500; `key` forces remount on market switch. See `charting-and-visualization.md`. |
| `DiscoverCarousel` | paged news cards (`DiscoverCard`) | `useDiscover(market)` | client-side paging (3/page); needsKey hint per market. |
| `CryptoGrid` | crypto cards (`CryptoCard`) | `useCrypto` | `LiveBadge` from `cryptoStatus`. |
| `ResearchView` | per-category notes (`ResearchNoteCard`) | `useResearch` | accordion "Full analysis"; long first-load copy. |
| `PredictionsGrid` | prediction cards (`PredictionCard`) | `usePredictions` | Yes-top/No-bottom ordering; `unit` → `$`/`Ṁ`. |
| `WatchlistAside` | sidebar watchlist | `useStocks(market)` | `CompanyLogo`; `money(price, currency)`; `LiveBadge`. |
| `EquitySectorsAside` | 11 SPDR / NSE sectors | `useSectors(market)` | INR uses `num()`, US uses `usd()`. |
| `PopularCryptoAside` | top-5 coins (stablecoins filtered) | `useCrypto` | de-duped — no extra request. |
| `PredictionsMiniAside` | top-3 markets, top outcome | `usePredictions` | hides itself if empty. |

**Formatting helpers** (top of the file — reuse, don't reinvent): `num` (locale 2dp), `usd`
(currency for ≥1, `toPrecision(3)` for sub-dollar coins), `money(n, "USD"|"INR")` (INR → `en-IN`
lakh/crore + ₹), `compact` (1.2B), `pct` (signed %), `signed`.

---

## 11. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Building a finance-specific chat answer renderer. | Reuse `ChatView`; make the agent emit `<ANSWER>`/`<SOURCES>`/`<FOLLOW_UPS>`. |
| Polling a hook faster than the backend TTL "to feel live". | Align `refetchInterval` to the TTL; liveness comes from `useLivePrices` tick-merge, not faster polls. |
| Forgetting `market` in the query key. | Key as `["finance",x,market]` so US/IN don't cross-contaminate. |
| Rendering a stale/needsKey card as a generic error or as fresh. | Branch `needsKey` → `loading/error` → `empty` → data; show `attribution`/`timeAgo`; surface `stale`. |
| Hardcoding a `<img src=logo.png>` or expecting the API to send logos. | `TICKER_DOMAIN` → Google favicon; `onError` → initials badge; store India tickers suffix-less. |
| Animating the accordion with motion / dropping `overflow-hidden`. | Keep the `.acc-content` + index.css `accordion-down/up` keyframes (`--radix-accordion-content-height`). |
| Wiring the composer's Mic button to STT. | It's a "coming soon" placeholder; use `chat-view`'s `MicButton` plumbing if adding voice. |
| Reading `section`/`model` from the closure inside the async stream. | Read the refs (`sectionRef.current`, `modelRef.current`) — `runTurn` doesn't re-bind. |
| Adding a new watchlist ticker without a domain. | Add it to `TICKER_DOMAIN` (or accept the initials badge). |
| Putting the vertical switcher inside `FinanceView`. | Section tabs live in `top-nav`; `FinanceView` only owns its Markets/Crypto/Research/Predictions sub-tabs. |

---

## 12. Adding a new dashboard card (checklist)

1. **Backend first:** fetcher + `Provenance` in `sources.ts`, route in `routes.ts`, add to cron
   warmer (see `lumina-finance-architecture.md` §5).
2. **`finance-api.ts`:** add the payload interface (+`needsKey`/`stale`/`provenance`) and a
   `fetchX` using `getJson<T>` + `marketQuery` if market-aware.
3. **`use-finance.ts`:** add `useX`, key `["finance","x",market?]`, `refetchInterval` = the TTL.
4. **`finance-view.tsx`:** build the card, branch `needsKey → loading/error → empty → data`, wrap in
   `<Section title attribution={data?.provenance.attribution}>`, reuse the formatters, and add
   `onError` fallbacks to any favicon/image. Place it in a sub-tab's content or the `<aside>`.
5. **Verify:** route returns 200 with live data; card shows freshness; switching US/IN re-fetches the
   `…,"in"` key; a missing key shows the `NeedsKey` hint (not a crash).
