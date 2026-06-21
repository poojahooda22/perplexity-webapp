# Crypto Asset Fundamentals — supply, market cap, dominance, stablecoins

> The concepts BEHIND the CoinGecko fields: coin vs token, **market cap vs FDV** vs the three
> supply numbers (circulating / total / max), 24h volume, BTC/ETH dominance, and stablecoin
> types + peg mechanisms — plus how to read what `coins/markets` actually returns. Read this
> when an answer needs the *meaning* of a number, not the wiring. Generic-domain knowledge; our
> code is cited only to show which fields we map and which we drop.
>
> Adjacent refs: the literal CoinGecko plumbing (fetchers, ids, budgets, headers) →
> `lumina-coingecko-data.md`; on-chain identity (why a token has a contract address) →
> `onchain-and-wallets.md`; TVL / liquidity / yield → `defi-concepts.md`; how to frame the
> risk these numbers expose → `crypto-volatility-and-risk.md`.

---

## 1. Coins vs tokens — the one distinction that organizes everything

| | **Coin** (native asset) | **Token** (smart-contract asset) |
|---|---|---|
| What it is | The native unit of its **own** blockchain | An asset issued by a **contract on someone else's** chain |
| Examples | BTC (Bitcoin), ETH (Ethereum), SOL (Solana), BNB | USDC, UNI, LINK, PEPE, most of the "alt" universe (ERC-20 on Ethereum, SPL on Solana) |
| Pays gas? | Yes — fees on its chain are paid in the coin | No — you still need the host chain's **coin** to move it (ETH to send USDC) |
| Identified by | Chain name / ticker | A **contract address** on a specific chain (this is its on-chain identity → `onchain-and-wallets.md`) |
| Supply controlled by | Protocol consensus rules (mining/issuance schedule) | The contract's mint/burn logic — can be mutable, ownable, or fixed |
| Create one | Launch/fork a blockchain (hard) | Deploy a contract (minutes; this is why 99% of "coins" are tokens and why most scams are tokens) |

**Why it matters for answers:**
- "I have USDT but can't send it" → they lack the **host-chain coin** for gas. Mechanism, not a bug.
- The **same ticker can be many different tokens** on different chains (bridged USDC, wrapped BTC, fake clones). A ticker is not an identity; a contract address is. CoinGecko's lowercase **id** disambiguates within its catalog — but two listings can share a symbol. (See Non-Negotiable #2 in `SKILL.md`: always resolve ticker → id.)
- Token contracts can have **mint authority, freeze authority, blacklists, transfer taxes**. None of that exists for a base-layer coin. Flag these as mechanisms (never "scam" / "safe" verdicts) → `crypto-safety-and-disclaimers.md`.

> Wrapped/bridged assets (wBTC, stETH, bridged-USDC) are *tokens that represent* a coin or another token. They carry **extra** risk (the bridge / custodian can fail) on top of the underlying. Say "a tokenized claim on X," not "X."

---

## 2. The three supply numbers — never use the wrong one

| Field | Meaning | The classic trap |
|---|---|---|
| **Circulating supply** | Units actually in the market right now (excludes locked/vested/treasury/burned) | The ONLY supply for **market cap**. Using total here overstates cap. |
| **Total supply** | Issued and existing today, **minus burned** (includes locked/unvested) | Mistaken for circulating; the gap = tokens that *will* hit the market (sell pressure). |
| **Max supply** | The hard ceiling the protocol will ever allow (`null`/∞ if uncapped) | BTC = 21M (capped). ETH = **no max** (uncapped, net-issuance varies). Don't invent a cap. |

```
burned ≤  circulating  ≤  total  ≤  max
                   └ float ┘   └ locked/unvested ┘   └ never-yet-minted ┘
```

**Low float, high unlock = the single most important supply risk.** If circulating is 8% of max and the rest unlocks over 2 years, today's price is set by a thin float while a large overhang waits. State it as a fact ("~8% of max supply circulates; the remainder vests through 20XX"), not as a call.

**Inflation vs deflation** is about the *trend* of supply, not a single number: new issuance (staking rewards, block rewards) inflates; **burns** (fee burns like ETH's EIP-1559, buyback-and-burn) deflate. "Deflationary" claims need the actual net-issuance, not marketing.

---

## 3. Market cap vs FDV vs volume — three different questions

| Metric | Formula | Question it answers | CoinGecko field |
|---|---|---|---|
| **Market cap** | `price × circulating supply` | What the **tradeable** float is worth *today* | `market_cap` |
| **FDV** (fully-diluted valuation) | `price × max (or total) supply` | What it'd be worth if **every** token existed at today's price | `fully_diluted_valuation` |
| **24h volume** | Sum of buy+sell turnover over 24h | **Liquidity / activity** — how much actually trades | `total_volume` |

**The MC/FDV gap is a tell, not a verdict.**

| MC ≈ FDV | Most supply already circulating; little dilution overhang ahead (BTC ≈) |
| MC ≪ FDV | Large future unlocks; the "real" valuation assumes dilution that hasn't happened — flag the overhang |

> **Market cap is NOT money invested and NOT cashable-out.** It's `price × float`; the marginal price comes from a thin order book. A $10B cap can't be sold for $10B — selling moves the price down the book. This is the #1 fundamentals error to avoid repeating.

**Volume sanity-checks the cap.** A coin with a huge market cap but tiny 24h volume is illiquid — the cap is "paper." `volume / market_cap` (turnover ratio) is a rough liquidity gauge. Also watch **wash trading**: reported volume can be fabricated on thin venues. Prefer CoinGecko's aggregate `total_volume` over a single exchange's number, and treat extreme ratios skeptically → `crypto-volatility-and-risk.md`.

**Ranking:** CoinGecko's `market_cap_rank` orders the universe by **circulating** market cap (this is the `order=market_cap_desc` our fetchers request). It is a size ranking, not a quality ranking.

### Decision framework — which number does the user actually want?

```
User asks "how big / how much is X worth?"
  ├─ "What's it worth today / how big is it now?"      → market cap   (price × circulating)
  ├─ "What if all tokens were unlocked / true value?"  → FDV          (price × max/total)  + flag the gap
  ├─ "Is it liquid / can I get in & out?"               → 24h volume + turnover ratio
  ├─ "How much can dump on the market later?"           → total − circulating (the overhang)
  └─ "Is there a hard cap / is it inflationary?"        → max supply (null = uncapped) + net issuance trend
Always: state which metric you used, the as-of time, and that cap ≠ cash-outable.
```

---

## 4. Dominance — a market-structure ratio, not a price

**Dominance = one asset's market cap ÷ total crypto market cap.** BTC dominance and ETH dominance are the common ones; "stablecoin dominance" and "others" round it out.

- **Rising BTC dominance** usually means money rotating *into* BTC / *out of* alts (risk-off within crypto). **Falling** BTC dominance during a rally is shorthand for "alt season."
- It is a **relative** figure: BTC dominance can rise while BTC's price falls (if alts fall faster). Never read dominance as a price direction.
- Total-market-cap and dominance come from CoinGecko's `/global` endpoint (`market_cap_percentage`), **not** from the `coins/markets` rows our fetchers use — so we don't currently surface it (see §6). If asked, source it explicitly and name it.

---

## 5. Stablecoins — types, pegs, and how each breaks

A stablecoin targets a peg (almost always **1 USD**). The peg is a *target*, not a guarantee — the mechanism determines how it holds and how it fails.

| Type | How the peg is held | Examples | Failure mode to state neutrally |
|---|---|---|---|
| **Fiat-collateralized** | 1:1 reserves (cash + T-bills) at a custodian; redeemable | USDC, USDT, PYUSD | **Reserve quality / custodian / banking risk.** USDC briefly hit ~$0.88 in Mar 2023 when reserves sat in a failed bank. Trust = trust in the attestations. |
| **Crypto-overcollateralized** | Locked crypto worth **>**100% backs each unit; liquidations defend the peg | DAI, LUSD, crvUSD | **Collateral crash + liquidation cascade**; partial centralization if backed partly by USDC. |
| **Algorithmic / under-collateralized** | Supply expands/contracts via incentives or a paired token; little/no hard backing | UST (collapsed May 2022), historical FRAX phases | **Reflexive death spiral** — peg loss feeds the mint/burn loop. Highest structural risk; say so plainly. |
| **Commodity / yield-bearing / other** | Backed by gold (PAXG) or tokenized T-bills paying yield | PAXG, several T-bill tokens | Pegged to the **commodity**, not USD; yield-bearing ones carry issuer + securities-treatment questions. |

**Reading stablecoins in our data:** a stablecoin still comes back as a normal `coins/markets` row — `price` hovers near 1.00, `price_change_percentage_24h` ≈ 0. A stablecoin reading **0.97 or 1.04 is a depeg signal**, not noise — surface it. USDT/USDC usually rank in the top 5 by market cap, so they appear in our top-12 crypto card.

**Depeg framing rule:** report the number and the mechanism ("USDC traded at $0.97; it's fiat-collateralized, so this reflects doubt about reserve access"), never "buy the depeg" / "it's safe."

---

## 6. Reading what CoinGecko returns — the fields WE map vs the ones we drop

Our [`mapCoinGeckoRow`](../../../../backend/finance/sources.ts) deliberately keeps a **thin** subset of the `coins/markets` payload. Know what we surface and what's available-but-unmapped.

**What we map** (the `CryptoCoin` type in [`sources.ts`](../../../../backend/finance/sources.ts)):

| Our field | CoinGecko field | Notes |
|---|---|---|
| `id` | `id` | lowercase canonical id (`bitcoin`) — the identifier to use, never the ticker |
| `symbol` | `symbol` | we **uppercase** it for display (`btc`→`BTC`); symbols collide, ids don't |
| `name`, `image` | `name`, `image` | display only |
| `price` | `current_price` | in `vs_currency=usd` (our fetchers hardcode USD) |
| `change24h` | `price_change_percentage_24h` | **percent**, can be `null` (we preserve null, never coerce to 0) |
| `marketCap` | `market_cap` | circulating-supply cap; nullable |
| `sparkline` | `sparkline_in_7d.price` | 7-day price array; **only requested when `sparkline=true`** — `fetchCryptoMarkets` sets `sparkline=false`, so the agent path returns `[]` here |

**What `coins/markets` ALSO returns but we currently DROP** (request via params / a new mapping if a feature needs them — see `lumina-coingecko-data.md`):

`total_volume`, `fully_diluted_valuation`, `circulating_supply`, `total_supply`, `max_supply`, `market_cap_rank`, `ath`/`atl` (+ their `_change_percentage`), `high_24h`/`low_24h`, and `price_change_percentage_{1h,7d,30d,…}` (only when you pass them in `price_change_percentage=`).

> **Implication:** today our crypto surface can show price, 24h%, market cap, and a 7d sparkline — it **cannot** answer FDV / supply / volume questions from our own data. If an answer needs those, either (a) extend the mapping + the `?price_change_percentage=`/default field set, or (b) source the number from a named call and say so. **Never fill the gap with a guessed figure** (Non-Negotiable #4).

```ts
// mapCoinGeckoRow keeps the thin set; note change24h preserves null, symbol is uppercased.
change24h: c.price_change_percentage_24h != null ? Number(c.price_change_percentage_24h) : null,
marketCap: c.market_cap != null ? Number(c.market_cap) : null,
sparkline: Array.isArray(c.sparkline_in_7d?.price) ? c.sparkline_in_7d.price.map(Number) : [],
```

**Null discipline:** every numeric CoinGecko field can be `null` (new listings, thin coins). Our mapper guards `market_cap`/`change24h`; if you add `fdv`/`supply` fields, **preserve null** and render "—" rather than `0`. A `0` market cap reads as "worthless"; a `null` reads as "unknown" — they are different answers.

---

## 7. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| "Market cap = money invested / amount you could cash out." | `price × circulating`; a thin order book means it can't be sold at that price. State cap ≠ cashable. |
| Computing market cap from **total** or **max** supply. | Cap uses **circulating**. `price × max/total` is **FDV** — a different metric; label it. |
| Quoting **FDV** as the coin's value without flagging the unlock overhang. | Say MC and FDV both; if MC ≪ FDV, name the future-dilution overhang as a neutral fact. |
| Treating `change24h` of `null` as `0%`. | Preserve null → render "—". Null = unknown, 0 = flat; don't conflate. |
| Reading 24h **volume** as market cap (or vice-versa). | Volume = turnover/liquidity; cap = float value. Cross-check: high cap + low volume = illiquid "paper" cap. |
| Assuming every coin has a **max supply**. | BTC=21M; ETH has **none**. If `max_supply` is null, say uncapped — don't invent a ceiling. |
| Reading **dominance** as a price signal. | It's a market-cap **ratio**; BTC dominance can rise while BTC falls. And it's a `/global` field — not in our `coins/markets` rows. |
| "Stablecoins are safe / always \$1." | The peg is a target; name the type and its failure mode. A 0.97/1.04 print is a **depeg signal** to surface. |
| Saying a number our data doesn't carry (FDV/supply/volume) as if mapped. | We map only price/24h%/cap/sparkline. Extend the mapping or source it by name; never guess. |
| Trusting a single exchange's volume. | Use CoinGecko's aggregate `total_volume`; treat extreme turnover ratios as possible wash trading. |
| Calling a token a "coin" (or ignoring it needs host gas). | Coin = native chain asset; token = contract asset needing the host chain's coin for gas. |

---

## 8. Quick reference — the formulas

```
market cap          = price × circulating_supply        (CoinGecko: market_cap)
FDV                 = price × max_supply (or total)      (CoinGecko: fully_diluted_valuation)
float %             = circulating_supply / max_supply    (low = thin float, watch unlocks)
overhang            = total_supply − circulating_supply  (tokens that can still hit market)
turnover ratio      = total_volume / market_cap          (rough liquidity gauge)
BTC dominance       = btc_market_cap / total_market_cap  (CoinGecko /global, NOT in coins/markets)
stablecoin peg dev. = price − 1.00                        (≠ 0 → depeg signal)
```

Every figure ships with **source + as-of time**, `null` rendered as "—" not `0`, and the
not-advice framing the agent path already staples via `withGuard` (see `SKILL.md` Non-Negotiables).
