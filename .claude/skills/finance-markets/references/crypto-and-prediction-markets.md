# Crypto & Prediction Markets — the data plumbing

> How Lumina turns CoinGecko + Polymarket/Manifold into clean, frontend-ready, honestly-labeled
> data — coin **ids vs tickers**, what `change24h`/`marketCap`/`sparkline` actually mean, and the
> prediction-market gotchas that bite everyone (JSON-string outcomes, USD-vs-mana units, the India
> geo-block). Pair with [`market-data-providers.md`](./market-data-providers.md) (limits/error
> shapes) and [`ai-sdk-finance-agent.md`](./ai-sdk-finance-agent.md) (how `getCrypto` plugs into the
> tool loop). For "why is BTC up" *domain* reasoning, see the runtime skill
> [`backend/finance/skills/crypto-research.md`](../../../../backend/finance/skills/crypto-research.md).

---

## Boundary — what THIS doc owns

| Owns | Routes elsewhere |
|------|------------------|
| The **finance data plumbing** for crypto + prediction markets: the fetchers in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts), the types they return, the cache/budget tools wrapping them in [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts), and the as-of/units/licensing honesty around all of it. | Deep crypto/DeFi/on-chain domain (tokenomics, smart contracts, L2s, staking yields, TVL) → the future **crypto-defi** skill. This skill stops at "get the number, label it, don't lie about units." |
| Coin-id↔ticker mapping, `change24h`/`marketCap`/`sparkline` semantics, volatility framing. | Charting mechanics (how the sparkline renders) → `charting-and-visualization.md`. |
| Polymarket→Manifold fallback, outcome probabilities, USD-vs-mana, geo-block timeout. | The agent loop/persona/`loadSkill` engine → `ai-sdk-finance-agent.md`. |

Two functions are the whole crypto surface: `fetchCrypto()` (the 12-card view) and
`fetchCryptoMarkets(ids)` (the agent's parameterized fetch). One function is the whole prediction
surface: `fetchPredictions()` (Polymarket with Manifold fallback). Everything below is grounded in
those.

---

## Part 1 — Crypto (CoinGecko)

### Coin **ids**, not tickers — the #1 mistake

CoinGecko's `coins/markets` endpoint is keyed by **coin id**, a lowercase slug, NOT the ticker symbol:

| User says | CoinGecko id (what you must send) | Ticker (`symbol` field, display only) |
|-----------|-----------------------------------|----------------------------------------|
| BTC, "Bitcoin" | `bitcoin` | BTC |
| ETH, "Ethereum" | `ethereum` | ETH |
| SOL | `solana` | SOL |
| "Doge" | `dogecoin` | DOGE |

`fetchCryptoMarkets` normalizes inputs with `s.trim().toLowerCase()` (in
[`backend/finance/sources.ts`](../../../../backend/finance/sources.ts), `fetchCryptoMarkets`), but
**lowercasing a ticker does not make it an id** — `"btc"` lowercased is still `"btc"`, and CoinGecko
returns nothing for it. The model is told in the `getCrypto` tool description and schema to pass
**coin ids (lowercase), e.g. `['bitcoin','ethereum']`** — that instruction is the mapping layer. If
you ever fetch from a ticker source (a watchlist, a user query "research SOL"), map ticker→id
*before* calling. There is no fuzzy resolver in the code today; the LLM does the mapping. Common
ambiguity to watch: many tickers collide (multiple coins share "SOL"/"UNI"); ids are unique, which is
exactly why CoinGecko uses them.

> **Do instead:** when adding any ticker-driven crypto feature, resolve to the canonical id first
> (hardcode a small map for the top coins, or hit `coins/list` once and cache it). Never send a raw
> ticker to `coins/markets`.

### What `fetchCrypto()` returns (the card view)

`fetchCrypto()` hits `coins/markets?vs_currency=usd&order=market_cap_desc&per_page=12&page=1&sparkline=true&price_change_percentage=24h`
— the **top 12 coins by market cap**, with a 7-day sparkline. Each row is mapped by
`mapCoinGeckoRow` into a `CryptoCoin`:

```ts
type CryptoCoin = {
  id: string;          // canonical CoinGecko slug ("bitcoin")
  symbol: string;      // ticker, UPPERCASED for display ("BTC")
  name: string;        // "Bitcoin"
  image: string;       // logo URL
  price: number;       // current_price in USD
  change24h: number | null;  // price_change_percentage_24h (PERCENT, e.g. -3.2 = down 3.2%)
  marketCap: number | null;  // market_cap in USD
  sparkline: number[];       // sparkline_in_7d.price — ~168 hourly points (7d)
};
```

Field semantics — be precise when surfacing these:

| Field | What it is | Common misread |
|-------|-----------|----------------|
| `price` | Spot in **USD** (`vs_currency=usd` is hardcoded). | It is not the user's local currency. |
| `change24h` | **Percent** change over 24h (already ×100; `-3.2` means −3.2%). Nullable. | It is *not* an absolute dollar delta, and *not* the sparkline's first-to-last. |
| `marketCap` | price × circulating supply, USD. Nullable. | Not fully-diluted valuation (FDV); not 24h volume. |
| `sparkline` | `sparkline_in_7d.price`, a flat array of ~hourly USD prices over **7 days** (not 24h). | The 7d trend ≠ the 24h % change — they can disagree (up over a week, down today). State both honestly. |

Nullability is real: `change24h` and `marketCap` default to `null` when CoinGecko omits them (new or
illiquid coins). `mapCoinGeckoRow` guards with `!= null` checks — never assume a number; the UI must
render "—" for null, and the agent must say "market cap unavailable," not "0."

### What `fetchCryptoMarkets(ids, {signal})` returns (the agent path)

This is the backend for the `getCrypto` tool. Same `CryptoPayload` shape, but:

- Takes an **explicit id list**, dedupes + lowercases + filters empties, and **caps at 20** ids
  (`.slice(0, 20)`). Empty list → returns `{ coins: [], provenance }` without a network call.
- **No sparkline** (`sparkline=false`) — the agent answers in prose, doesn't need 168 points per coin;
  this keeps the payload small.
- `per_page` is set to the request size so CoinGecko returns exactly the asked coins.
- Threads an `AbortSignal`: a hard `AbortSignal.timeout(8000)` combined with the caller's optional
  signal via `AbortSignal.any([opts.signal, timeout])`. **But note** — the *tool* layer
  ([`backend/finance/tools.ts`](../../../../backend/finance/tools.ts), `getCrypto`) deliberately does
  **not** pass the client-disconnect signal into the cached fetcher, because the fetcher is shared
  across concurrent callers (in-flight de-dupe); one user's disconnect must not abort everyone's
  fetch. The `signal` param exists for direct/uncached callers.

### How `getCrypto` wraps it (cache + budget)

In [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts), `getCrypto`:

- Normalizes ids (`toLowerCase`, dedupe, `sort` for a stable cache key), schema-capped at **15 ids**.
- Cache key `finance:cryptomkt:<sorted,ids>`, **TTL 30s** (crypto moves fast — short TTL), through
  `cachedToolFetch("getCrypto", 20, ...)`.
- **Budget = 20 calls/min** (CoinGecko Demo ≈ 100/min per the code comment in `tools.ts`; ample
  headroom left). Enforced *inside*
  `getOrRefresh` so a cache HIT is never charged. Over budget + nothing stale to serve →
  `{ unavailable: "Live crypto data is rate-limited right now — try again shortly." }`.
- Returns `{ coins, provenance, fetchedAt, stale }` — always with the as-of time and stale flag, so
  the agent can state freshness honestly.

> **Why 30s TTL, not 300s** (like indices): crypto trades 24/7 and is far more volatile than an
> index; a 5-minute-old BTC price can be materially wrong. The short TTL is a deliberate
> freshness-vs-budget trade, kept affordable by the 20/min budget + de-dupe.

### Stablecoins — flag them, don't treat them as "flat assets"

USDT/USDC/DAI appear in the top-12 by market cap and will surface in `fetchCrypto()`. Their `price`
hovers near $1.00 and `change24h` near 0 **by design** (they peg to USD). Two honesty rules:

- Don't present a stablecoin's ~0% 24h move as "stable performance" — it's a peg, not a thesis.
- A **depeg** (price drifting from $1, e.g. USDC's $0.88 in March 2023) is the *only* interesting
  signal for a stablecoin and is a risk event worth calling out. The data exposes it via `price`
  diverging from 1.0; nothing in the code special-cases it, so the agent must.

### Volatility framing (the honesty contract)

The runtime skill is explicit: **"Crypto is highly volatile — never give buy/sell advice. End with
'Not financial advice.'"** The data layer supports this with the same honesty primitives as the rest
of finance:

- Always state the **as-of time** (`fetchedAt`) and surface `stale`.
- A 24h percent move on a volatile asset is noise as often as signal — present the number, not a
  verdict.
- Liquidity/regulatory risk is qualitative; the data doesn't carry it, so the agent adds it from
  `financeWebSearch` context, neutrally.

---

## Part 2 — Prediction markets (Polymarket → Manifold)

### The fallback architecture

`fetchPredictions()` in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) tries
**Polymarket first** (real-money markets — the authentic signal, what Lumina shows), and falls
back to **Manifold** (play-money, open API) when Polymarket is unreachable. **One source per
response** — never a mix. The fallback exists because **Polymarket is geo-blocked in India** (and
some other regions): the dev environment is in India, so without the fallback the panel would be
permanently empty in dev.

```
fetchPredictions()
  ├─ try fetchPolymarket()  (gamma-api, real-money, USD)
  │     └─ if it throws OR returns 0 markets → fall through
  └─ catch → fetchManifold() (play-money, mana, reachable from India)
```

Note the subtle guard: an **empty** Polymarket result (`markets.length === 0`) is treated as a
failure (`throw new Error("Polymarket returned no markets")`) so the catch fires and Manifold fills
the panel — a reachable-but-empty response should not leave the UI blank.

### The geo-block + 4.5s timeout — why a hang, not an error

Polymarket in a blocked region doesn't *refuse* the connection (which would fail fast) — **the TCP
connect HANGS**. DNS resolves; the socket never completes. So a normal `fetch` would sit there until
some default timeout, stalling the whole request. The fix is an explicit short abort:

```ts
const PREDICTION_TIMEOUT_MS = 4500;          // abort fast, then fall back
async function fetchWithTimeout(url, ms, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
```

4.5s is tuned to give Polymarket a fair chance when reachable while keeping the fallback snappy when
it's blocked. The aborted fetch throws → `catch` → Manifold. **Do instead:** any provider that may
hang on geo-block gets a hard `AbortController` timeout, not a reliance on the platform default.

### Outcomes arrive as JSON-encoded STRINGS — `parseJsonArray`

This is the bug everyone hits. Polymarket's Gamma API returns `outcomes` and `outcomePrices` **not as
arrays but as JSON-encoded strings**:

```jsonc
{ "outcomes": "[\"Yes\",\"No\"]", "outcomePrices": "[\"0.62\",\"0.38\"]" }
```

You must `JSON.parse` them before use. `parseJsonArray` handles both shapes defensively (already an
array → map to strings; a string → parse, return `[]` on malformed):

```ts
function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }
  return [];
}
```

In `fetchPolymarket`, labels = `parseJsonArray(m.outcomes)`, prices =
`parseJsonArray(m.outcomePrices).map(Number)`, then zipped by index into
`outcomes: [{ label, probability }]`, with `probability` guarded by `Number.isFinite(prices[i]) ? prices[i] : 0`.

> **Do instead:** treat *every* Gamma field as possibly string-encoded. Never `m.outcomes.map(...)`
> directly — it's a string, `.map` will throw or iterate characters.

### Reading implied probability

For a Polymarket binary market, **`outcomePrice` IS the implied probability**: a share that pays $1
if "Yes" resolves true, priced at $0.62, means the market implies a **62% probability** of "Yes."
Prices across mutually-exclusive outcomes sum to ~1.0. So:

- `probability: 0.62` → render as **62%**.
- The price/probability is the headline number for a prediction market — not the volume.

Manifold differs: binary markets expose a single `probability` (0–1) directly, and
`fetchManifold` derives the pair:

```ts
outcomes: prob != null
  ? [{ label: "Yes", probability: prob }, { label: "No", probability: 1 - prob }]
  : []
```

Both providers therefore normalize into the **same** `PredictionOutcome[]` shape
(`{ label, probability }`), so the UI/agent reads probabilities identically regardless of source.

### USD vs mana — the units honesty rule

`volume` means **different things** depending on which source answered, and the `Provenance.unit`
field carries the distinction so nothing lies:

| Source | `unit` | What `volume` is | Honest label |
|--------|--------|------------------|--------------|
| Polymarket | `"USD"` | Real-money trading volume in dollars. | "$X traded" — a real-money signal. |
| Manifold | `"mana"` | Play-money ("mana") volume. **Not dollars.** | "X mana (play money)" — a community/interest signal, not financial stakes. |

The `Provenance` type declares `unit?: "USD" | "mana"`, and `fetchPredictions` sets it per branch.
**Never render a mana volume with a `$`.** And when the answer comes from Manifold, the agent must say
the probabilities are from a *play-money* market — informative about crowd belief, but not backed by
real capital like Polymarket's. Surfacing the wrong unit (or omitting it) is the prediction-market
equivalent of inventing a price.

Polymarket volume itself is robust to field drift: `volumeNum` (number) is preferred, then
`Number(m.volume)`, else `null`. Manifold uses `volume24Hours` → `volume` → `null`.

### What `fetchPredictions()` returns

```ts
type PredictionOutcome = { label: string; probability: number };       // probability 0–1
type PredictionMarket = {
  id: string; question: string; url: string | null; image: string | null;
  volume: number | null;        // in provenance.unit's currency (USD or mana)
  endDate: string | null;       // ISO; Manifold's closeTime is ms → toISOString()
  outcomes: PredictionOutcome[];
};
type PredictionsPayload = { markets: PredictionMarket[]; provenance: Provenance };
```

Polymarket query: `markets?limit=12&active=true&closed=false&order=volume24hr&ascending=false` — the
12 most-traded *open* markets. Manifold: `search-markets?term=&sort=score&filter=open&contractType=BINARY&limit=12`
— top open binary markets. Both capped at 12 for the panel.

### Licensing — both `commercialOk: false`

Every prediction payload carries `commercialOk: false` (Polymarket *and* Manifold), with attribution
strings `"Prediction market data from Polymarket"` / `"...from Manifold Markets"`. As with crypto,
this is the hard gate: fine to build/demo, **not cleared for public display** until commercial-display
ToS is confirmed. There is no agent tool for prediction markets today — they surface only on the
finance card view via the route layer.

---

## Mirroring the runtime playbook (`crypto-research.md`)

The runtime skill loaded by the agent via `loadSkill`
([`backend/finance/skills/crypto-research.md`](../../../../backend/finance/skills/crypto-research.md))
defines the *answer shape* for a crypto question. When building/extending crypto features, make sure
the data path can feed every part of it:

| Playbook step | Data dependency it needs from this layer |
|---------------|------------------------------------------|
| 1. Call `getCrypto` with coin id(s) | `change24h`, `marketCap`, `price` populated → coin id resolution must work. |
| 2. `financeWebSearch` for "why is it moving" | Belongs to the agent loop (`ai-sdk-finance-agent.md`), not here — but the crypto answer leans on it for catalysts. |
| 3. One-line summary: price, 24h move, market-cap size | `price` + `change24h` (percent) + `marketCap` (USD). State market-cap *size* (large/mid/small), not just the raw number. |
| 3. Risk note: volatility, liquidity, regulatory | Qualitative; the data flags only volatility (24h %) — liquidity/regulatory come from web search. |
| 4. State as-of time; never advise; "Not financial advice." | `fetchedAt` + `stale` on every `getCrypto` result; the honesty contract is non-negotiable. |

There is intentionally **no** prediction-markets runtime skill — predictions are a passive card, not
an agent capability. If you add one, write a sibling runtime skill and load it via `loadSkill`,
mirroring this structure.

---

## Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Sending a ticker (`btc`, `SOL`) to CoinGecko `coins/markets`. | Map ticker→coin id first; send `bitcoin`/`solana`. The endpoint is id-keyed. |
| Treating `change24h` as a dollar delta or as the sparkline's first-vs-last. | It's an already-×100 **percent**. The 7d sparkline is a separate, possibly-contradicting trend. |
| Calling `m.outcomes.map(...)` on a Polymarket market. | `outcomes`/`outcomePrices` are JSON **strings** — run them through `parseJsonArray` first. |
| Rendering Manifold volume with a `$`. | Read `provenance.unit`; Manifold is **mana** (play money), label it as such and never as dollars. |
| Presenting a Manifold probability as a real-money market signal. | Say it's a play-money community market — interest, not capital. Polymarket is the real-money source. |
| Relying on `fetch`'s default timeout for Polymarket. | Polymarket geo-block **hangs** the socket — use the 4.5s `AbortController` timeout, then fall back to Manifold. |
| Treating a stablecoin's ~0% move as a performance verdict. | It's a peg; the only signal is a **depeg** (price ≠ $1). Call that out as a risk event. |
| Long TTL on crypto because indices use 300s. | Crypto is 24/7 and volatile — keep `getCrypto` at 30s; the 20/min budget makes it affordable. |
| Assuming `marketCap`/`change24h`/`probability`/`volume` are always present. | All are nullable in the code. Render "—"/say "unavailable" — never substitute 0. |
| Flipping `commercialOk:true` because the API returned data. | It gates *legal display*, not technical access. Crypto + predictions stay `false` until a paid/confirmed commercial license. |
| Threading the client-disconnect signal into the shared cached crypto fetcher. | The fetcher is de-duped across callers; cancellation happens at the `streamText` level (see `tools.ts` note). |
| Mixing Polymarket and Manifold markets in one response. | One source per response — `fetchPredictions` picks exactly one and labels its unit. |

---

## Quick reference — the surface area

| Function | File | Returns | Notes |
|----------|------|---------|-------|
| `fetchCrypto()` | [`sources.ts`](../../../../backend/finance/sources.ts) | `CryptoPayload` (top 12, 7d sparkline) | Card view; `vs_currency=usd`, `sparkline=true`. |
| `fetchCryptoMarkets(ids, {signal})` | [`sources.ts`](../../../../backend/finance/sources.ts) | `CryptoPayload` (no sparkline, cap 20) | Agent path; lowercases ids, `AbortSignal.any` timeout. |
| `getCrypto` tool | [`tools.ts`](../../../../backend/finance/tools.ts) | `{coins, provenance, fetchedAt, stale}` | Cache `finance:cryptomkt:*`, TTL 30s, budget 20/min, schema cap 15. |
| `fetchPredictions()` | [`sources.ts`](../../../../backend/finance/sources.ts) | `PredictionsPayload` | Polymarket→Manifold; 4.5s timeout; one source; `unit` USD/mana. |
| `parseJsonArray(v)` | [`sources.ts`](../../../../backend/finance/sources.ts) | `string[]` | Decodes Gamma's JSON-string `outcomes`/`outcomePrices`. |
| `crypto-research.md` (runtime) | [`skills/crypto-research.md`](../../../../backend/finance/skills/crypto-research.md) | — | Loaded via `loadSkill`; defines the crypto answer shape. |

> **Honesty checklist for any crypto/prediction change:** coin id resolution works · `change24h`
> labeled as percent · `parseJsonArray` applied to Gamma fields · `unit` (USD/mana) surfaced · nulls
> rendered as "—" · `fetchedAt`/`stale` shown · `commercialOk:false` respected · "Not financial
> advice." on agent prose.
