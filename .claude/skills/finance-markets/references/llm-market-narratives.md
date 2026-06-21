# LLM Market Narratives — summaries, research notes, and Discover

> How Lumina turns fresh web sources into **original** market prose the legal way:
> Tavily gathers multiple independent stories → `generateObject` (Zod-shaped) writes a new
> note that blends them → we link out to the sources and **never republish their text**. Two
> surfaces: a cheap fast **Market Summary** (Haiku) and a stronger multi-category **Global
> Research** (Sonnet), both on long TTLs warmed by cron. For the news-card carousel see
> [`news.ts`](../../../../backend/finance/news.ts) (covered below); for the legal rule in full
> read [`data-licensing-and-compliance.md`](./data-licensing-and-compliance.md); for the *chat*
> agent's narrative tools (`financeWebSearch`) read [`ai-sdk-finance-agent.md`](./ai-sdk-finance-agent.md).

Files:
[`backend/finance/summary.ts`](../../../../backend/finance/summary.ts),
[`backend/finance/research.ts`](../../../../backend/finance/research.ts),
[`backend/finance/news.ts`](../../../../backend/finance/news.ts),
routes + cron in [`backend/finance/routes.ts`](../../../../backend/finance/routes.ts).

---

## 1. The three narrative surfaces at a glance

| Surface | File | Source step | Model | Output shape | Route | TTL | Cron-warmed? |
|---|---|---|---|---|---|---|---|
| **Market Summary** | `summary.ts` | Tavily `topic:"news"`, 3 days, 8 results | **Haiku** (`anthropic/claude-haiku-4.5`) | `{ items:[{headline,body}], sources[] }` | `GET /finance/summary` (market-aware) | **900s** (15 min) | yes — US + IN |
| **Global Research** | `research.ts` | Tavily per category, 10 days, 8 results × 6 categories | **Sonnet** (`anthropic/claude-sonnet-4.6`) | `{ notes:[{title,summary,keyPoints[],body[],sources[]}] }` | `GET /finance/research` | **21600s** (6 h) | no (warm only summary; research is heavy + slow-moving) |
| **Discover carousel** | `news.ts` | Finnhub `/news` (US) / NewsData.io→Tavily (IN) | **none** (no LLM) | `{ articles:[{title,source,url,image,publishedAt}] }` | `GET /finance/discover` (market-aware) | **600s** (10 min) | not in the cron list |

The first two are **LLM narratives**; Discover is **headline cards, no synthesis** (and no model
spend) — it is here because it shares the same legal shape (link-out, never the body text).

---

## 2. The legally-clean transformative-synthesis pattern (the whole point)

This is the rule the whole file is built around — get it wrong and a public launch is a copyright
problem. Two distinct legal moves, depending on whether the LLM writes prose or we just show a card:

**A. LLM narrative (summary + research): transformative multi-source synthesis.**
We feed the model snippets from **≥3 independent sources** and instruct it to write an **ORIGINAL**
note that *blends* them with its own analysis — then we cite + link out. We never reproduce a single
source's wording, and never summarize just one article. The prompt enforces this verbatim in
`fetchResearchNote` ([`research.ts`](../../../../backend/finance/research.ts)):

> `CRITICAL: do NOT reproduce any single source's wording and do NOT summarize just one article — synthesize across multiple sources. If the snippets are thin, write a shorter note rather than inventing facts.`

Why this is defensible: facts aren't copyrightable; *expression* is. Blending many sources into new
prose is transformative (the standard editorial/analyst move). Paraphrasing **one** article closely
is derivative and infringing — which is exactly what the prompt forbids.

**B. News cards (Discover): link-out only, body text dropped.**
We display **headline + source name + timestamp + outbound link + (hotlinked) thumbnail only** — the
publisher's `summary`/lede/body is deliberately **never** included. This is the Google-News /
Perplexity-Discover model. The infringing pattern is displaying the publisher's lede verbatim
(AP v. Meltwater) or full text (News Corp v. Perplexity) — the *card format* is fine. The code drops
the snippet on every path: Finnhub `a.summary` is commented "intentionally NOT included", and the
Tavily fallback omits `r.content`. See [`news.ts`](../../../../backend/finance/news.ts).

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Prompt the LLM to "summarize this article." | Prompt it to synthesize ACROSS ≥3 sources into an original note (the research.ts wording). |
| Single-source Tavily query (`maxResults:1`). | `maxResults:8` so the model has multiple independent stories to blend. |
| Render the publisher's snippet/lede in a card. | Drop `summary`/`content`; show headline+source+time+link only (see `news.ts`). |
| Re-host a publisher image to your CDN. | Hotlink the source's own `image`/og:image (never re-host). |
| Flip `commercialOk:true` because the API call worked. | It gates legal *display*, not technical access. Summaries/research/Discover all ship `commercialOk:false` until written clearance — see [`data-licensing-and-compliance.md`](./data-licensing-and-compliance.md). |
| Let the model invent levels when snippets are thin. | Instruct "write a shorter note rather than inventing facts" + "do NOT invent anything not supported by the snippets." |

Every narrative payload carries provenance with `commercialOk:false`. Summary's is
`{ source:"Tavily + AI", commercialOk:false, attribution:"AI summary of web sources" }`. This is
build-and-demo-safe; a public launch needs the display-clearance work in the licensing ref.

---

## 3. The `generateObject` + Zod pattern (copy this for any new narrative)

Both narratives use the Vercel AI SDK's `generateObject` — the model is **constrained to a Zod
schema**, so you get typed structured output (no JSON-parsing-the-model's-prose, no markdown
scraping). The `.describe()` on each field is part of the prompt — it tells the model what each
slot is for.

```ts
import { generateObject } from "ai";
import { z } from "zod";

// Bounds matter: .min/.max keep the output card-sized; .describe steers each field.
const NoteSchema = z.object({
  title: z.string().describe("a sharp, specific headline for the note"),
  summary: z.string().describe("a 2-sentence thesis"),
  keyPoints: z.array(z.string()).min(3).max(5).describe("quantified takeaways, each with numbers"),
  body: z.array(z.string()).min(2).max(4).describe("short paragraphs that blend the sources"),
});

const { object } = await generateObject({
  model: "anthropic/claude-sonnet-4.6", // bare string id → routed via Vercel AI Gateway
  schema: NoteSchema,
  prompt: `…synthesize an ORIGINAL note from the snippets below…\n\n${context}`,
});
// object is fully typed: object.keyPoints is string[], guaranteed length 3–5.
```

The model id is a **bare string** (e.g. `"anthropic/claude-sonnet-4.6"` /
`"anthropic/claude-haiku-4.5"`), which the AI SDK routes through the **Vercel AI Gateway**
(`AI_GATEWAY_API_KEY`) — the same gateway the chat agent resolves models through. No per-provider
client is constructed in these files.

**Why `generateObject` over `streamText`+parse:** these are batch, cached, non-streamed payloads
served as JSON to the frontend — there's no user watching tokens. Structured output gives a typed
contract the route can splat into the response (`{ ...r.data, fetchedAt, stale }`). Reserve
`streamText` for the interactive chat agent.

---

## 4. Model choice rationale — Haiku for summary, Sonnet for analysis

| | Market Summary | Global Research |
|---|---|---|
| Model | `anthropic/claude-haiku-4.5` | `anthropic/claude-sonnet-4.6` |
| Job | 5 punchy headline+body items from fresh news | 6 "institution-grade" analytical notes |
| Why this model | cheap + fast; the task is light extraction/condensation; result is cached so amortized cost ≈ 0 | flagship "JPM-grade" content needs stronger reasoning to synthesize across sources; still cached, so cost stays low |
| Volume | 1 call per market per 15-min window | 6 calls (parallel) per 6-h window |
| Code comment | "Haiku is cheap + fast and the result is cached, so cost is minimal." | "Sonnet for the flagship 'JPM-grade' content; result is cached, so cost stays low." |

The rule: **match model strength to the cognitive load, then let the long TTL amortize the cost.**
Summary is condensation (Haiku is plenty); research is multi-source synthesis with quantified
takeaways (worth Sonnet). Because both are cached behind long TTLs, even Sonnet × 6 categories costs
pennies per window — the cache is what makes "use the better model" affordable. Verify exact model
ids against the live files before quoting; the gateway naming has drifted before.

---

## 5. Market Summary in detail (`summary.ts`)

`fetchMarketSummary(market)` ([`summary.ts`](../../../../backend/finance/summary.ts)):

1. **Market-aware query + focus.** US: "S&P 500, Nasdaq, Dow, Treasury yields, the Fed, oil, and
   crypto"; IN: "NIFTY 50, S&P BSE Sensex, Nifty Bank, the RBI, the rupee, top NSE and BSE movers."
   The `focus` string is appended to the prompt so the editorial lens matches the market.
2. **Tavily news search:** `tvly.search(query, { searchDepth:"basic", topic:"news", days:3, maxResults:8 })`.
   `topic:"news"` + `days:3` keeps it to *recent market-movers*, not evergreen pages.
3. **Build two things from the results:** `sources[]` (title + url + a **240-char** snippet for the
   sources drawer) and `context` (the numbered `[i] title\ncontent` block the model reads).
4. **`generateObject` with Haiku** + the `items` schema (3–6 items, each `{headline, body}`).
   The prompt: markets-editor persona, "be factual and specific with numbers where present", and
   "Do NOT invent anything not supported by the snippets."
5. **Return** `{ items, sources, updatedAt, provenance }`.

The `sources[]` array is what the UI renders as **source chips / favicons + a sources drawer** — the
240-char snippet is the only place a publisher's text appears, and it's a short factual excerpt in a
citation context (the drawer), not a republished body. The headline+body **items** are the model's
own prose. This is the citation half of the transformative pattern: own prose + link-out citations.

---

## 6. Global Research in detail (`research.ts`)

`RESEARCH_CATEGORIES` ([`research.ts`](../../../../backend/finance/research.ts)) defines six fixed
buckets, each with a `key`, `label`, and a seed `query`:

| key | label | query theme |
|---|---|---|
| `rates` | Rates | Fed/ECB/BoJ, Treasury/bond yields |
| `credit` | Credit | spreads, HY/IG, private credit, default cycle |
| `equities` | Equities | S&P 500 valuations, earnings, sector rotation |
| `economics` | Economics | inflation/CPI/GDP, labor, recession risk |
| `market-structure` | Market Structure | ETFs, liquidity, options flow, CLOs |
| `digital-assets` | Digital Assets | crypto, stablecoins, tokenization, regulation |

`fetchResearchNote(categoryKey)`:
1. Look up the category (throws on unknown key).
2. Tavily search `\`${cat.query} 2026 analysis\`` with `topic:"news"`, **`days:10`** (analysis moves
   slower than the daily summary), `maxResults:8`.
3. Build `sources[]` (title+url only — no snippet here) and a `context` block where each entry is
   `[i] title (hostname)\ncontent` — the hostname is parsed from the URL so the model can weight by
   outlet.
4. **`generateObject` with Sonnet** + `NoteSchema` (title, 2-sentence summary, 3–5 quantified
   keyPoints, 2–4 body paragraphs). The prompt is the strategist persona + the **CRITICAL** no-single-
   source-no-invention rule.
5. Return the note with `category`, `label`, the model fields, `sources`, `updatedAt`.

**`fetchAllResearch()`** runs all six in parallel with **`Promise.allSettled`**, then keeps only the
`fulfilled` ones:

```ts
const settled = await Promise.allSettled(RESEARCH_CATEGORIES.map((c) => fetchResearchNote(c.key)));
const notes = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
```

This is the **partial-degrade** pattern: one slow/failed category (Tavily timeout, a model hiccup)
**drops out** of the surface instead of 502-ing the whole `/finance/research` page. Pair it with the
cache (§7) — a failed category just isn't in the cached payload until the next refresh.

---

## 7. Caching, long TTLs, and cron warming (why the first user never pays cold-gen)

LLM+Tavily generation is **slow and costs money**, so it must run ~once per refresh window, not
per view. Two mechanisms in [`routes.ts`](../../../../backend/finance/routes.ts):

**Long TTLs via `getOrRefresh`.** Every route is a `readRoute`/`marketReadRoute` over the shared
cache: a HIT serves instantly; a MISS runs the fetcher (one LLM generation) and stores it; on
upstream failure it serves **stale rather than 500**.

```
TTL = { …, summary: 900, research: 21_600, discover: 600 }   // 15min / 6h / 10min
```

Summary is market-aware → US lives at `finance:summary`, India at `finance:in:summary` (separate keys
in `marketReadRoute`). Research is a single non-market route at `finance:research`.

**Cron warming (the key trick).** `POST /finance/cron/refresh` (guarded by `CRON_SECRET`, wired to a
free external scheduler like cron-job.org since **Vercel can't hold timers**) forces a refresh of
every series with `getOrRefresh(key, 0, fn)` — TTL 0 means "always regenerate now". The summary jobs
are explicitly in the warm list **for both markets**:

```ts
["summary",    () => fetchMarketSummary("us")],
["in:summary", () => fetchMarketSummary("in")],
```

The in-code comment states the why exactly: *"warm them so the first user after a TTL lapse doesn't
pay the cold generation cost (they're otherwise never pre-warmed)."* Without warming, the unlucky
first viewer after each 15-min lapse waits the full Tavily+Haiku round-trip; with it, the cron keeps
the entry hot so every real user gets a cache HIT.

| Surface | In cron warm list? | Rationale |
|---|---|---|
| `summary` (US + IN) | **yes** | short TTL (15m) + user-facing home → cold-gen latency would be visible; warm it. |
| `research` | **no** | 6h TTL, heavy (6× Sonnet), changes slowly — a rare cold-gen is acceptable; don't burn the budget every cron tick. |
| `discover` | **no** | no LLM cost, 10m TTL, cheap to regenerate on demand. |

If you add a new LLM narrative on a short TTL, **add it to the cron job list** — otherwise the
first-user-pays-cold-gen problem returns silently. If it's on a multi-hour TTL, warming is optional.

---

## 8. Discover carousel (`news.ts`) — cards, not narrative

No LLM here, but it lives in the narrative family because it's the **link-out** half of the legal
rule. `fetchDiscover(market)` ([`news.ts`](../../../../backend/finance/news.ts)):

- **US:** Finnhub `/news?category=general` → sort newest-first → **dedup by canonical URL + exact
  title** → keep top `MAX_ARTICLES` (18). `a.summary` (publisher text) is **dropped**; image is the
  hotlinked thumbnail. Empirically the free Finnhub general feed is Reuters/CNBC/Bloomberg with ~100%
  images — which is *why* `commercialOk` stays false and written display clearance matters before a
  public launch.
- **India:** `fetchDiscoverIndia` prefers **NewsData.io** (`image=1` so cards have real per-article
  images; `removeduplicate=1`; falls back to a keyword-only query if plan-gated params 400) when
  `NEWSDATA_API_KEY` is set, else falls back to **Tavily** scoped to `INDIA_NEWS_DOMAINS`
  (moneycontrol, livemint, ET…) and enriched with each publisher's **og:image** (hotlinked, browser
  UA; blockers keep a clean placeholder).
- **`canonicalUrl`** strips tracking params/hash/trailing slash for stable dedup ids.
- Every payload carries `commercialOk:false` provenance and the body text is never displayed on any
  path.

This is the same legal shape as the LLM surfaces, just without the synthesis step — headline + source
+ timestamp + outbound link + thumbnail, nothing more.

---

## 9. Adding a new LLM narrative — the checklist

1. **Source step:** Tavily (or another provider) with `topic:"news"` + a `days` window that matches
   how fast the content moves (3 for daily, 10 for analysis). `maxResults:8` so there are ≥3
   independent sources to synthesize — never single-source.
2. **Build `sources[]` (link-out) + a numbered `context` block** the model reads. Keep any source
   snippet short and only in a citation context (the drawer), never as displayed body.
3. **Zod schema** with bounded arrays (`.min/.max`) and `.describe()` on every field; keep it
   card-sized.
4. **`generateObject`** with a **bare-string gateway model id** — Haiku for condensation, Sonnet for
   synthesis/analysis. Prompt must demand **original synthesis across sources** and **no invention**
   when snippets are thin (copy the research.ts wording).
5. **Provenance** with `commercialOk:false` until the licensing ref clears it.
6. **Route:** wrap in `readRoute`/`marketReadRoute` with a **long TTL** through `getOrRefresh`
   ([`routes.ts`](../../../../backend/finance/routes.ts)).
7. **Multi-part?** Use `Promise.allSettled` so one failure degrades partially (like `fetchAllResearch`).
8. **Short TTL + user-facing?** Add it to the **cron warm list** in `POST /finance/cron/refresh`.
9. **New backend file → full dev-server restart** (Bun `--hot` does not pick up new files); relative
   imports need explicit `.js` extensions for Vercel's ESM resolver.

---

## 10. Common tasks → where

| Task | Do |
|---|---|
| Add a research category | Append to `RESEARCH_CATEGORIES` in `research.ts` (key/label/query); `fetchAllResearch` picks it up automatically. |
| Change summary editorial focus | Edit the market-aware `query`/`focus` strings in `fetchMarketSummary`. |
| Summary/research feels generic or invents numbers | Strengthen the prompt's "synthesize across sources" + "don't invent" lines; raise `maxResults`; confirm ≥3 sources came back. |
| First user after a TTL lapse waits seconds | Confirm the surface is in the cron warm list; confirm the external scheduler is hitting `POST /finance/cron/refresh` with `CRON_SECRET`. |
| "Can we display this?" | It can't — `commercialOk:false` everywhere here. Read [`data-licensing-and-compliance.md`](./data-licensing-and-compliance.md). |
| Make the *chat agent* cite news | Not here — that's `financeWebSearch` in [`ai-sdk-finance-agent.md`](./ai-sdk-finance-agent.md). |
| Add a news source to Discover | Extend `fetchDiscover`/`INDIA_NEWS_DOMAINS` in `news.ts`; drop the publisher body; hotlink images. |
