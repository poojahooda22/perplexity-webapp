# Prediction Markets — Polymarket → Manifold mechanics in our code

> What the numbers in our prediction-market panel actually mean, and how the code coaxes them out
> of two very different APIs. Read this when touching `fetchPredictions` / the predictions card / the
> agent quoting a market probability — i.e. anything that says "the market gives X a Y% chance."
> This is the **project-grounded** ref (every claim cites
> [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)). Sibling refs cover adjacent
> ground: `crypto-asset-fundamentals.md` (market cap vs FDV, supply), `crypto-safety-and-disclaimers.md`
> (the not-advice framing this data also needs), and the finance plumbing twin
> `finance-markets/crypto-and-prediction-markets.md` (the *cache/route/tool* wiring — TTL 120s, the
> `/finance/predictions` route, separate from this *meaning* layer).

Files: `fetchPredictions` / `fetchPolymarket` / `fetchManifold` / `parseJsonArray` in
[`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) (lines ~97–228); the
`PredictionMarket` / `PredictionOutcome` / `Provenance.unit` types (lines ~15–20, 99–109).

---

## 1. What a prediction market IS (one paragraph, so the framing is right)

A prediction market is a marketplace where people **trade contracts that pay $1 if an event happens
and $0 if it doesn't**. The trading price of the "Yes" share — between 0 and 1 — IS the market's
collective **implied probability** of the event. If "Yes" trades at $0.63, the crowd is pricing the
event at ~63%. That is the single most important fact for our code: the `outcomePrices` array
Polymarket returns is **already a probability**, not a dollar price you must normalize. We pass it
straight into `PredictionOutcome.probability`. Two consequences run through everything below: (1) it's
an *implied probability*, a moving crowd estimate, **never a forecast or a fact**; (2) the *unit of
the money behind it* differs by venue — real USD on Polymarket, play-money "mana" on Manifold — and
we must label which.

---

## 2. The two providers — at a glance

| | **Polymarket** (primary) | **Manifold** (fallback) |
|---|---|---|
| Endpoint | `gamma-api.polymarket.com/markets` (`POLYMARKET_GAMMA`) | `api.manifold.markets/v0/search-markets` (`MANIFOLD_API`) |
| Auth | None (public Gamma API) | None (open API) |
| Money | **Real USD** | **Mana** — play money, no cash value |
| `provenance.unit` | `"USD"` | `"mana"` |
| Probability source | `outcomePrices` (JSON-string array, 0–1) | `probability` (a single number, binary) |
| Outcomes shape | N-ary: `outcomes` labels + `outcomePrices` parallel array | binary only — we synthesize `Yes / No` from `prob` / `1 - prob` |
| India reachable? | **No** — geo-blocked; TCP connect *hangs* | **Yes** |
| `commercialOk` | `false` (confirm display ToS first) | `false` |
| Why this one | Authentic real-money markets (what the Lumina Finance tab shows) | Always reachable → the panel never goes empty |

Both are wrapped by **one** entry point, `fetchPredictions()` — callers never pick a provider. It
tries Polymarket, and on *any* failure (geo-block, timeout, outage, **or zero markets**) falls back to
Manifold. **One source per response** — never a merged list (the units don't mix).

---

## 3. The Polymarket parse — the JSON-string gotcha

Gamma does NOT return `outcomes` / `outcomePrices` as JSON arrays. It returns them as
**JSON-encoded strings inside the JSON** — e.g. the field value is the literal string
`"[\"Yes\",\"No\"]"`, not the array `["Yes","No"]`. Hand that to `.map()` and you iterate characters,
not labels. `parseJsonArray` is the un-double-encode step:

```ts
// sources.ts — Gamma double-encodes these fields as JSON strings.
function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);          // already an array → trust it
  if (typeof v === "string") {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; }
    catch { return []; }                                // malformed → empty, never throw
  }
  return [];                                            // null/number/object → empty
}
```

Then `fetchPolymarket` zips the two parallel arrays by **index** into outcomes:

```ts
const labels = parseJsonArray(m.outcomes);             // ["Yes","No"]
const prices = parseJsonArray(m.outcomePrices).map(Number); // [0.63, 0.37]
outcomes: labels.map((label, i) => ({
  label,
  probability: Number.isFinite(prices[i]) ? prices[i]! : 0,  // guard NaN/short array → 0
})),
```

Three load-bearing details:
- **`.map(Number)`** turns the string prices into floats; a missing/garbage price becomes `NaN`,
  which the `Number.isFinite` guard converts to `0` — so a malformed row degrades to "0% on that
  outcome" rather than crashing the card.
- **Parallel-array zip by index** assumes `outcomes[i]` ↔ `outcomePrices[i]`. That's Gamma's
  contract; don't sort or filter one array without the other or labels and probabilities desync.
- **Robust id / question fallbacks:** `id` falls back `id → conditionId → slug → ""`; `question`
  falls back `question → groupItemTitle → "Untitled market"`. The card always renders something.

`volume` prefers the numeric `volumeNum`, else coerces `volume` — and on Polymarket it's **USD
traded** (real money). The market URL is built from the slug: `https://polymarket.com/event/${slug}`.

---

## 4. The Manifold parse — binary synthesis from a single probability

Manifold's `search-markets` (filtered `contractType=BINARY`) gives **one** `probability` per market,
not a parallel array. We synthesize the two-outcome shape so the frontend renders both venues
identically:

```ts
const prob = typeof m.probability === "number" ? m.probability : null;
outcomes: prob != null
  ? [ { label: "Yes", probability: prob },
      { label: "No",  probability: 1 - prob } ]
  : [],                                                 // no prob → empty outcomes, still listed
```

`volume` prefers `volume24Hours` then `volume`; `endDate` is `closeTime` (epoch ms) →
`new Date(closeTime).toISOString()` to match Polymarket's already-ISO `endDate`. The unit is
**mana** — and that is the single most important thing to surface downstream (see §6).

---

## 5. The India geo-block + fast-timeout fallback — why 4.5 s, not 8 s

Polymarket is geo-blocked in some regions (India among them). The cruel part: a blocked request does
**not** get a fast TCP refusal — the connection **hangs**. A naive `fetch` would sit until the
default timeout and make the whole predictions card feel broken. So `fetchWithTimeout` wraps an
`AbortController` with a deliberately *short* `PREDICTION_TIMEOUT_MS = 4500`:

```ts
async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
```

The fallback orchestration in `fetchPredictions`:

```
fetchPolymarket()  ── 4.5s timeout ──►  markets.length === 0 ?  throw  ─┐
   │ ok & non-empty                                                     │  catch (geo-block / timeout
   ▼                                                                    ▼   / outage / "no markets")
return { markets, unit: "USD",  source: "Polymarket" }    fetchManifold() (4.5s) → unit:"mana"
                                                          return { markets, source:"Manifold Markets" }
```

Decision rules baked into the code:
- **Empty Polymarket result counts as failure** — `if (markets.length === 0) throw` — so a 200-with-
  zero-rows triggers the fallback instead of rendering an empty card.
- **The fallback is logged, not silent:** `console.warn("[finance] Polymarket unavailable, using
  Manifold:", …)` so you can see in logs why a response is mana-denominated.
- **Why 4.5 s and not the 8 s used elsewhere** (Yahoo/Twelve Data use 8000): from India the Polymarket
  call is *expected* to fail, and we'd rather spend the budget reaching Manifold. A long timeout here
  is wasted latency on the common geo-blocked path.

> **TTL / cache note:** `fetchPredictions` itself does no caching — that lives one layer up in the
> finance route/tool (`/finance/predictions`, TTL **120 s**). See
> `finance-markets/crypto-and-prediction-markets.md`. 120 s is fine because prediction probabilities
> move far slower than spot crypto prices.

---

## 6. Decision framework — how to PRESENT a prediction number

When the agent (or a card) is about to say something about a market, walk this:

```
About to quote a prediction-market number
|
+-- Is provenance.unit "mana"?  ──► say "play-money community odds on Manifold" — NOT a money market.
|                                    Never imply real capital is backing it.
+-- Is it a probability (0–1)? ──► frame as the market's IMPLIED probability ("the market prices ~63%"),
|                                    a moving crowd estimate, NOT a forecast/guarantee/fact.
+-- Is it volume?             ──► Polymarket = USD traded; Manifold = mana. Label the unit explicitly.
+-- Quoting it as evidence?  ──► attribute the source + that probabilities update continuously; pair
|                                    with the not-advice line (crypto-safety-and-disclaimers.md).
+-- Multi-outcome market?    ──► the outcomes array is parallel label↔probability; sum ≈ 1 (Polymarket).
                                     Don't report one leg as "the" probability of a 3+ outcome market.
```

The `provenance.unit` field exists *precisely* to drive the mana-vs-USD branch — read it, don't assume.

---

## 7. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| `m.outcomes.map(...)` directly on the Gamma field. | It's a JSON **string**, not an array — run it through `parseJsonArray` first or you map over characters. |
| Treating `outcomePrices` as a dollar price to normalize. | It's already a 0–1 implied **probability**; pass straight to `PredictionOutcome.probability`. |
| Reporting Manifold odds/volume as if real money. | Check `provenance.unit === "mana"`; say play-money community odds. Mana has no cash value. |
| Calling a probability a forecast/fact ("X will happen, 63%"). | "The market currently prices ~63% — an implied, continuously-updating crowd estimate, not a prediction." |
| Using an 8 s timeout for Polymarket. | Geo-blocked = hangs; the short `PREDICTION_TIMEOUT_MS` (4.5 s) fails fast so the Manifold fallback fires before the request feels dead. |
| Treating a 200-with-zero-markets as success. | `fetchPredictions` `throw`s on empty so the fallback runs — replicate that guard if you add a provider. |
| Merging Polymarket + Manifold markets into one list. | One source per response — the units (USD/mana) and probability semantics don't mix. Keep them separate. |
| Assuming `outcomes[i]` and `outcomePrices[i]` can be sorted/filtered independently. | They're a parallel zip by index — transform both together or labels and probabilities desync. |
| Flipping `commercialOk:true` because the public Gamma API "just works." | It gates *legal display*, not access. Both providers stay `false` until display ToS is confirmed. |
| Caching/serving a stale probability silently as live. | Surface the route's `fetchedAt`/`stale` (TTL 120 s upstream); probabilities move — don't present a stale one as current. |
| Quoting a single leg of a 3+ outcome market as "the" probability. | Report the relevant outcome's leg by label; the legs sum to ~1 on Polymarket. |

---

## 8. Field reference — what `PredictionMarket` carries

| Field | Type | Polymarket source | Manifold source | Notes |
|------|------|-------------------|-----------------|-------|
| `id` | string | `id → conditionId → slug` | `id` | always non-empty |
| `question` | string | `question → groupItemTitle` | `question` | falls back to `"Untitled market"` |
| `url` | string \| null | `polymarket.com/event/${slug}` | `m.url` | link-out for citation |
| `image` | string \| null | `image → icon` | `coverImageUrl` | card thumbnail |
| `volume` | number \| null | `volumeNum → volume` (**USD**) | `volume24Hours → volume` (**mana**) | unit is in `provenance.unit` |
| `endDate` | string \| null | `endDate` (already ISO) | `closeTime` (epoch ms → ISO) | when the market resolves |
| `outcomes` | `{label, probability}[]` | parallel `outcomes`/`outcomePrices` zip | synthesized `Yes/No` from `probability` | probability ∈ [0,1] |

`provenance`: `{ source, commercialOk:false, attribution, unit }` — `unit` is the USD/mana
discriminator; `attribution` is `"Prediction market data from Polymarket"` /
`"…from Manifold Markets"` and must render when the data is displayed.

---

## 9. Cross-skill routing

- **finance-markets / `crypto-and-prediction-markets.md`** — the *plumbing* twin: the cache + 120 s
  TTL, the `/finance/predictions` route, and how the `getCrypto`/predictions tools wire into the agent
  loop. This ref owns *meaning*; that one owns *wiring*.
- **`crypto-safety-and-disclaimers.md`** (this skill) — the not-advice framing every probability needs;
  the agent path already staples `_disclaimer` via `withGuard` (see
  [`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts)).
- **ai-sdk-agent** — how the agent decides to surface a market at all (tool loop, `stopWhen`).
- Project memory: `finance-tab-build`, `india-markets-kb` capture the geo-block + fallback decision.
  Verify any `file:line` against live `sources.ts` before relying on it — line numbers drift.
