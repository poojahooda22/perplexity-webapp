# CoinGecko in Lumina — the crypto data plumbing

> What CoinGecko actually returns in THIS codebase and how we read it: the two fetchers
> (`fetchCrypto` for the dashboard card, `fetchCryptoMarkets` for the agent), the `getCrypto`
> tool, the Demo-key header, the `commercialOk:false` licensing gate, and the cache + per-minute
> budget caps. `lumina-` ref = grounded in live code; cite the file before you change it (line
> numbers drift). For the *concepts* behind the fields (market cap vs FDV, supply, dominance,
> stablecoins) read the sibling [`crypto-asset-fundamentals.md`](./crypto-asset-fundamentals.md);
> for prediction markets read [`prediction-markets-deep.md`](./prediction-markets-deep.md); for the
> provider-selection / cache / licensing *plumbing* in the round, cross-ref finance
> `market-data-providers.md` + `caching-and-rate-budgets.md` + `data-licensing-and-compliance.md`.

Files: [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) (the fetchers),
[`backend/finance/tools.ts`](../../../../backend/finance/tools.ts) (the `getCrypto` tool).

---

## 1. The two CoinGecko entry points (and why there are two)

Lumina hits CoinGecko's `/coins/markets` endpoint from exactly two places, both in
[`sources.ts`](../../../../backend/finance/sources.ts). They differ only in *which* coins they ask
for — and that single difference is the whole design.

| Fetcher | Caller | Coins requested | Sparkline? | Cap | Purpose |
|---|---|---|---|---|---|
| `fetchCrypto()` | Finance **dashboard** card (`/finance/crypto` route) | top 12 by market cap (`order=market_cap_desc&per_page=12`) | **yes** (`sparkline=true`) | n/a (fixed 12) | compute-once-serve-many landing card |
| `fetchCryptoMarkets(ids)` | The **chat agent** via `getCrypto` | a SPECIFIC id list (`?ids=bitcoin,ethereum`) | **no** (`sparkline=false`) | first **20** ids after dedupe | answer "BTC vs ETH" with a live quote |

Both return the same `CryptoPayload = { coins: CryptoCoin[]; provenance: Provenance }`
(`sources.ts` lines 34, 24-33), so everything downstream (frontend, tool, attribution) is uniform.
The dashboard fetcher asks for a sparkline because the card draws one; the agent fetcher skips it
(the model only needs the number, and a 7-day price array is wasted tokens).

```
Dashboard card  ── fetchCrypto() ──────────►  GET /coins/markets?…per_page=12&sparkline=true
                                                    │ (same endpoint, same mapper)
Chat agent ── getCrypto tool ── fetchCryptoMarkets(ids) ─► GET /coins/markets?ids=…&sparkline=false
```

---

## 2. The request: exact query shape

`fetchCrypto()` (`sources.ts` lines 64-72):

```ts
const url =
  `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
  `&per_page=12&page=1&sparkline=true&price_change_percentage=24h`;
```

`fetchCryptoMarkets(ids)` (`sources.ts` lines 88-91):

```ts
const url =
  `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(list.join(","))}` +
  `&order=market_cap_desc&per_page=${list.length}&page=1&sparkline=false&price_change_percentage=24h`;
```

`COINGECKO_BASE = "https://api.coingecko.com/api/v3"` (`sources.ts` line 36).

| Query param | Value | Why |
|---|---|---|
| `vs_currency` | `usd` | All CoinGecko data is denominated in USD here; crypto has no "INR market" the way Yahoo gives native INR for `.NS` stocks. |
| `ids` (agent only) | lowercased, deduped, comma-joined coin ids | **The id is the unit of identity, not the ticker** — see §4. |
| `order` | `market_cap_desc` | Card = top coins; agent = stable ordering of the requested set. |
| `per_page` | 12 (card) / `list.length` (agent) | Ask for exactly what you need; never page through the full ~10k-coin universe (R-SCALE: the client never holds the whole list). |
| `sparkline` | `true` card / `false` agent | The card draws a 7d line; the agent doesn't need it. |
| `price_change_percentage=24h` | both | Adds `price_change_percentage_24h` to each row → our `change24h`. Without it the field is absent. |

---

## 3. The response → `CryptoCoin` mapping

Every row passes through one mapper, `mapCoinGeckoRow` (`sources.ts` lines 43-54). Know the
CoinGecko field → our field translation cold — this is where wrong-field bugs hide:

| `CryptoCoin` field | CoinGecko source field | Notes |
|---|---|---|
| `id` | `id` | the canonical lowercase id (`"bitcoin"`), **not** a ticker |
| `symbol` | `symbol` → **upper-cased** | display ticker (`"BTC"`); lossy & ambiguous, never round-trip it back to the API |
| `name` | `name` | `"Bitcoin"` |
| `image` | `image` | coin logo URL |
| `price` | `current_price` | falls back to `0` if missing |
| `change24h` | `price_change_percentage_24h` | **`number \| null`** — `null` when absent, NOT `0`. A real 0% and "no data" are different; preserve the null. |
| `marketCap` | `market_cap` | `number \| null`; = circulating supply × price (NOT FDV — see fundamentals ref) |
| `sparkline` | `sparkline_in_7d.price` | `number[]`; empty `[]` if the row didn't request/return it (agent path → always `[]`) |

```ts
change24h: c.price_change_percentage_24h != null ? Number(c.price_change_percentage_24h) : null,
marketCap: c.market_cap != null ? Number(c.market_cap) : null,
sparkline: Array.isArray(c.sparkline_in_7d?.price) ? c.sparkline_in_7d.price.map(Number) : [],
```

**Why nullable matters:** the `!= null` guard distinguishes "field absent" from a genuine `0`.
Coercing absent → `0` would render a fake "0.00% / $0 market cap" — a fabricated number, which
violates non-negotiable #4. Keep the `null` and let the UI show "—".

---

## 4. The id-not-ticker rule (the #1 footgun)

CoinGecko's `?ids=` filter wants **coin ids** (`bitcoin`, `ethereum`, `solana`) — lowercase, slug
style — **not** tickers (`BTC`, `ETH`, `SOL`). Tickers collide across chains (dozens of coins use
`UNI`/`SOL`-like symbols), so a ticker query is ambiguous or empty.

The code defends this twice:

- **Tool input** (`getCrypto.inputSchema`, `tools.ts` lines 93-99): described as
  `"CoinGecko coin ids (lowercase), e.g. ['bitcoin','ethereum']"` so the model supplies ids.
- **Tool normalize** (`tools.ts` line 101): `[...new Set(ids.map((s) => s.toLowerCase()))].sort()`.
- **Fetcher normalize** (`fetchCryptoMarkets`, `sources.ts` line 82):
  `[...new Set(ids.map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 20)` — trims,
  lowercases, dedupes, drops empties, caps at 20.

Empty after normalize → returns `{ coins: [], provenance: cgProvenance() }` (no upstream call) —
`sources.ts` line 83.

> **You** (when wiring a user ticker → tool call) must map `BTC → bitcoin` before invoking
> `getCrypto`. The code lowercases but does **not** translate ticker→id. Mapping belongs in the
> persona/skill layer, not the fetcher. See [`crypto-asset-fundamentals.md`](./crypto-asset-fundamentals.md)
> for the id/ticker/contract-address distinction.

---

## 5. The `getCrypto` tool (the agent path)

`getCrypto` (`tools.ts` lines 89-113) is the only way the chat agent touches crypto prices. Anatomy:

```ts
const getCrypto = tool({
  description:
    "Get price, 24h percent change, and market cap for one or more cryptocurrencies by " +
    "CoinGecko coin id (e.g. bitcoin, ethereum, solana). Use for crypto price or compare questions.",
  inputSchema: z.object({
    ids: z.array(z.string()).min(1).max(15)
      .describe("CoinGecko coin ids (lowercase), e.g. ['bitcoin','ethereum']."),
  }),
  execute: async ({ ids }) => {
    const list = [...new Set(ids.map((s) => s.toLowerCase()))].sort();
    const key = `finance:cryptomkt:${list.join(",")}`;
    const res = await cachedToolFetch("getCrypto", 20, key, 30, () => fetchCryptoMarkets(list));
    if (!res.ok) return { unavailable: "Live crypto data is rate-limited right now — try again shortly." };
    const r = res.r;
    return { coins: r.data.coins, provenance: r.data.provenance,
             fetchedAt: new Date(r.fetchedAt).toISOString(), stale: r.stale };
  },
});
```

Then registered with the budget/log/disclaimer hook: `getCrypto: withGuard("getCrypto", getCrypto)`
(`tools.ts` line 175).

**Two id caps, and they differ on purpose:**
- Tool schema: `.max(15)` (`tools.ts` line 97) — what the *model* is allowed to ask for.
- Fetcher: `.slice(0, 20)` (`sources.ts` line 82) — a hard backstop independent of the caller.

The schema cap keeps the model from requesting a giant set; the fetcher cap protects any *other*
caller of `fetchCryptoMarkets`. Belt and suspenders.

**Return states (typed, never a thrown error to the model):**

| Situation | Returns | Model should say |
|---|---|---|
| success | `{ coins, provenance, fetchedAt, stale }` | the prices, naming CoinGecko + the as-of time |
| over budget / upstream 429 with nothing cached | `{ unavailable: "Live crypto data is rate-limited…" }` | "live crypto data is momentarily rate-limited — try again shortly" |
| empty id list | `{ coins: [] }` | "I couldn't resolve that to a coin" |

Note `getCrypto` has **no `needsKey` branch** (unlike `getQuote`): CoinGecko's Demo endpoint works
*without* a key, so the call never blocks on a missing key — it just runs keyless at a lower limit.

---

## 6. The Demo key header

`coingeckoHeaders()` (`sources.ts` lines 38-41):

```ts
function coingeckoHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { "x-cg-demo-api-key": key } : {};
}
```

| Fact | Detail |
|---|---|
| Header name | `x-cg-demo-api-key` — the **Demo** header, NOT `x-cg-pro-api-key`. |
| Env var | `COINGECKO_API_KEY` (server-side only; never reaches the client — non-negotiable). |
| Keyless | No key → empty headers → the public free endpoint still works (good for local dev), at a stricter shared-IP limit (~5-15/min in practice vs ~30/min keyed Demo, ~100/min on some Demo plans). |
| Pro | A Pro key would change the header to `x-cg-pro-api-key` **and** the base host to `pro-api.coingecko.com`. We are on the *public* host + Demo header; switching to Pro is a two-line change (host + header name) + flipping `commercialOk`. |

---

## 7. The licensing gate: `commercialOk: false`

`cgProvenance()` (`sources.ts` lines 56-62):

```ts
function cgProvenance(): Provenance {
  return {
    source: "CoinGecko",
    commercialOk: false, // Demo tier = personal use; flip true on a paid commercial plan.
    attribution: "Data provided by CoinGecko",
  };
}
```

**`commercialOk` is the hard display gate, and CoinGecko's Demo tier is PERSONAL-USE.** A working
free key is *not* a commercial-display license. Every crypto series in Lumina is therefore
build-and-demo-only until a paid plan flips this.

| Question | Answer |
|---|---|
| What flips `commercialOk:true`? | A **paid** CoinGecko plan with public-display terms. Basic (~$35/mo) is the cheapest commercial tier (see the file header comment, `sources.ts` lines 5-8). |
| Does a working key flip it? | **No.** It gates *legal display*, not technical access. |
| What attribution renders? | `"Data provided by CoinGecko"` — the exact `provenance.attribution` string. Render it wherever crypto data shows. |
| Where's the full licensing logic? | finance `data-licensing-and-compliance.md`. This ref only states the value the code sets. |

---

## 8. Budgets & caps (don't blow the free tier)

CoinGecko Demo is generous compared to Twelve Data, but the agent loop can still hammer it, so the
crypto fetch goes through the cache + per-minute budget like every finance tool.

| Knob | Value | Set in | Why |
|---|---|---|---|
| Cache TTL (agent) | **30 s** | `cachedToolFetch("getCrypto", 20, key, 30, …)` (`tools.ts` line 103) | crypto moves in seconds; 30 s balances freshness vs upstream load |
| Cache TTL (card) | **30 s** | `/finance/crypto` route TTL (finance `routes.ts`) | same cadence; the cron warmer keeps it hot |
| Per-minute budget | **20/min** | `cachedToolFetch("getCrypto", 20, …)` (`tools.ts` line 103) | well under CoinGecko Demo's ~100/min, with headroom for the card + other callers sharing the key |
| Cache key | `finance:cryptomkt:${sorted ids}` | `tools.ts` line 102 | sorted+joined so `[eth,btc]` and `[btc,eth]` share one cache entry |
| Hard timeout | **8 s** | `AbortSignal.timeout(8000)` (`sources.ts` line 85) | bound a hung upstream; combined with the caller's disconnect signal via `AbortSignal.any` |

**The HIT-not-charged invariant.** The budget check lives *inside* the fetcher passed to
`getOrRefresh`, so a cache HIT never spends budget (`tools.ts` `cachedToolFetch`, lines 28-45):

```ts
const r = await getOrRefresh(key, ttlSec, () => {
  if (!withinBudget(name, perMinute)) throw new RateBudgetError(name);
  return fetcher();           // ← runs ONLY on a MISS, so only a MISS is budgeted
});
```

If over budget AND nothing cached to serve stale, `getOrRefresh` rethrows `RateBudgetError`,
`cachedToolFetch` returns `{ ok: false }`, and the tool returns `{ unavailable }` — never a fake
number, never a 500. (Full cache mechanics: finance `caching-and-rate-budgets.md`.)

---

## 9. AbortSignal threading (the subtle part)

`fetchCryptoMarkets` accepts an optional `signal` and combines it with the hard timeout
(`sources.ts` lines 85-86):

```ts
const timeout = AbortSignal.timeout(8000);
const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
```

But the `getCrypto` tool calls `fetchCryptoMarkets(list)` **without** a signal (`tools.ts` line 103)
— deliberately. The fetcher is wrapped by `getOrRefresh`, which **de-dupes concurrent callers** onto
one shared upstream fetch. Threading caller A's disconnect signal into that shared fetch would abort
caller B too. So client-disconnect cancellation happens one level up, at the `streamText`
`abortSignal` (see finance `ai-sdk-finance-agent.md` §2). The fetcher *supports* a signal for direct
(non-deduped) callers; the tool path intentionally doesn't pass one.

---

## 10. Decision framework: which path / what to touch

```
Need crypto data in Lumina?
|
+-- It's the DASHBOARD card (top coins, with sparkline) ----► fetchCrypto()  (no args, fixed top-12)
+-- It's the CHAT AGENT answering about specific coins -----► getCrypto tool → fetchCryptoMarkets(ids)
+-- I have a user TICKER (BTC) not an id -------------------► map ticker→id FIRST, then call getCrypto
+-- I need 24h change / market cap / supply meaning --------► crypto-asset-fundamentals.md (concepts)
+-- The number must DISPLAY publicly ----------------------► commercialOk gate: finance data-licensing ref
+-- A 429 / rate limit / "unavailable" ---------------------► budgets §8 + finance caching-and-rate-budgets
+-- Prediction markets (not coins) ------------------------► prediction-markets-deep.md
```

---

## 11. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Calling `getCrypto`/`fetchCryptoMarkets` with `BTC`/`ETH` tickers. | Pass lowercase CoinGecko **ids** (`bitcoin`, `ethereum`). The API filters by id; a ticker returns wrong/empty results. Map ticker→id in the persona/skill layer. |
| Round-tripping our `symbol` field back into the API. | `symbol` is the upper-cased display ticker — lossy and ambiguous. Keep the original `id` for any re-fetch. |
| Coercing a missing `change24h`/`market_cap` to `0`. | Preserve `null` (the `!= null` guard does). `0` and "no data" differ; a fake 0 is a fabricated number. |
| Adding `sparkline=true` to the agent fetch. | The agent doesn't render a 7d line — it's wasted payload/tokens. Sparkline is for the dashboard card only. |
| Putting the budget check *before* `getOrRefresh`. | Check **inside** the fetcher so a cache HIT isn't charged (the documented prior bug). |
| Threading the request's AbortSignal into the shared cached fetch. | It's de-duped across callers; one disconnect would abort all. Cancel at the `streamText` level. |
| Flipping `commercialOk:true` because "the Demo key works." | Demo = personal use. Only a paid CoinGecko plan with display terms flips it. |
| Using the `x-cg-pro-api-key` header / `pro-api` host with our current setup. | We're on the public host + `x-cg-demo-api-key`. Pro is a separate host AND header — change both together or auth fails. |
| Paging the full coin universe to "search all coins." | Never. Ask for a fixed `per_page` / specific `ids`. The client must not hold ~10k coins. |
| Answering a crypto price from model memory when the tool returns `{unavailable}`. | Say live data is momentarily rate-limited; never substitute a remembered/guessed figure. |

---

## 12. Adding a new CoinGecko-backed field or fetcher (checklist)

1. **Map it in `mapCoinGeckoRow`** with a `!= null` guard if it can be absent; type it
   `number | null` (or array → `[]`) in `CryptoCoin`. Don't coerce absent → 0.
2. **Request it** — many CoinGecko fields need an explicit query param (like
   `price_change_percentage=24h`); add the param or the field won't appear.
3. **Route through the cache + budget** via `cachedToolFetch(name, perMinute, key, ttl, fetcher)`;
   pick `perMinute` under the Demo cap with headroom (current crypto budget = 20).
4. **Set/keep `cgProvenance()`** so the new series carries `commercialOk:false` + the CoinGecko
   attribution — it inherits the licensing gate for free.
5. **Return typed states** from any tool: success object / `{unavailable}` on budget / `{coins:[]}`
   on empty. Wrap with `withGuard` so the not-advice `_disclaimer` is stapled on.
6. **Cap the input** (schema `.max` AND a fetcher `.slice`) so neither the model nor a stray caller
   can blow the budget with a huge id list.
7. **Restart the dev server** if you add a new file — Bun `--hot` misses new files; relative imports
   need explicit `.js`.

---

## 13. Cross-references

- **Concepts behind the fields** (market cap vs FDV, circulating/total/max supply, dominance,
  stablecoins, how to *read* what CoinGecko returns) → [`crypto-asset-fundamentals.md`](./crypto-asset-fundamentals.md).
- **Prediction markets** (`fetchPredictions`, Polymarket→Manifold, USD vs mana, implied
  probability) → [`prediction-markets-deep.md`](./prediction-markets-deep.md).
- **The cache + per-minute budget mechanics in full** → finance `caching-and-rate-budgets.md`.
- **Provider selection / limits / error shapes across all vendors** → finance `market-data-providers.md`.
- **The `commercialOk` gate, attribution strings, free-tier-display trap** → finance
  `data-licensing-and-compliance.md`.
- **The agent tool loop / `withGuard` / `cachedToolFetch` / disconnect handling** → finance
  `ai-sdk-finance-agent.md`.
- **`backend/connectors/crypto.ts` is cryptography (AES-GCM), NOT cryptocurrency** — never cite it
  for crypto-asset data. The crypto-asset code is `backend/finance/sources.ts` + `tools.ts`.
