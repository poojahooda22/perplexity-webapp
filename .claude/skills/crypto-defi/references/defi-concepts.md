# DeFi Concepts — DEXs, AMMs, lending, staking, yield, TVL

> The mechanics behind decentralized finance, framed so Lumina can explain them *correctly* and
> present their risk **neutrally**. Generic-domain knowledge (no DeFi code ships in this repo yet);
> read it when a crypto answer touches a DEX, an AMM/liquidity pool, impermanent loss, lending,
> staking, yield, or TVL, or when you need a **free** data source (DefiLlama) for protocol metrics.
> Adjacent refs: [`crypto-asset-fundamentals.md`](./crypto-asset-fundamentals.md) (coins/tokens,
> market cap vs FDV, supply, stablecoins), [`onchain-and-wallets.md`](./onchain-and-wallets.md)
> (EVM vs Solana, explorers, gas, custody — the rails DeFi runs on),
> [`crypto-volatility-and-risk.md`](./crypto-volatility-and-risk.md) (how to present risk), and the
> Lumina plumbing/licensing in finance-markets (`data-licensing-and-compliance.md`).

This is **generic crypto-domain knowledge**, not a wiring map. The repo has CoinGecko price/market
plumbing ([`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)) but **no DeFi/TVL
fetcher** — so the patterns below are how you'd *frame* DeFi in an answer and, if you add a TVL card,
which free source to wire (DefiLlama) following the same `Provenance` + cache + budget contract the
finance skill defines.

---

## 1. The vocabulary in one table (read this first)

| Term | One-line meaning | The number it produces |
|------|------------------|------------------------|
| **DeFi** | Financial services (trade, lend, borrow, earn) run by smart contracts instead of a company. | — |
| **DEX** | Decentralized exchange — trade tokens peer-to-contract, no order book operator. | Swap price, slippage |
| **AMM** | Automated Market Maker — the pricing algorithm a DEX uses (a formula, not a bid/ask book). | Pool price from a curve |
| **Liquidity pool (LP)** | A smart-contract reserve of two (or more) tokens that traders swap against. | Pool reserves, depth |
| **LP token** | Receipt token proving your share of a pool; redeem it to withdraw your deposit + fees. | Your pool share |
| **Impermanent loss (IL)** | The shortfall vs just holding, caused by the pool rebalancing as prices diverge. | A % drag on LP returns |
| **Lending protocol** | Pooled over-collateralized lending (Aave/Compound class): supply to earn, borrow against collateral. | Supply APY, borrow APR |
| **Staking** | Locking a PoS token to help secure the chain (or a protocol) in exchange for rewards. | Staking APR/APY |
| **Liquid staking** | Staking that returns a tradeable receipt token (e.g. stETH) so the position stays usable. | LST exchange rate |
| **Yield farming** | Chasing returns by moving capital across LP/lending/staking, often + incentive tokens. | Net APY |
| **APR vs APY** | APR = simple annual rate; **APY compounds** it. Headline farm numbers are usually APY. | Annualized return |
| **TVL** | Total Value Locked — USD value of assets deposited in a protocol/chain. | The "size" metric |
| **Yield aggregator / vault** | Auto-compounds and rotates a strategy for you (Yearn class). | Vault APY (net of fees) |

---

## 2. DEXs and AMMs — how a price comes from a formula

A centralized exchange matches a **buyer's bid** to a **seller's ask** in an order book. A DEX has no
operator and (classically) no order book; an **AMM** prices trades against a **liquidity pool** using
a deterministic curve. Liquidity providers (LPs) deposit both sides of a pair; traders swap against
the reserves; LPs earn the swap fee.

**Constant-product AMM (Uniswap v2 class), the canonical model.** The pool holds reserves `x` and `y`
and enforces:

```
x * y = k        (k held constant on every swap, before fees)
price of X (in Y) = y / x          // marginal price = ratio of reserves
```

A buy of token X *removes* X from the pool and *adds* Y, so `x` falls, `y` rises, and the price of X
**rises along the curve** — that price impact is **slippage**. Bigger trade vs pool depth = more
slippage. Fees (e.g. 0.30%) are added to reserves, nudging `k` upward over time — that accrual is the
LP's yield.

```
slippage ≈ trade size / pool depth      // intuition, not the exact formula
deeper pool  → less slippage, tighter price
thinner pool → more slippage, easy to "move the market" (a manipulation vector)
```

**AMM variants you should name correctly:**

| Design | Curve / idea | Best for | Watch-out |
|--------|--------------|----------|-----------|
| Constant product (Uni v2) | `x*y=k` | Any volatile pair | High IL on divergence |
| StableSwap (Curve) | Flattened curve near 1:1 | Like-priced assets (USDC/USDT, stETH/ETH) | Breaks if a "stable" depegs |
| Concentrated liquidity (Uni v3) | LP picks a price range | Capital-efficient market making | IL realized fast if price exits range; active management |
| Weighted pools (Balancer) | n-token, custom weights | Index-like baskets | Same IL family, multi-asset |

> **Slippage tolerance vs MEV:** a swap sets a max acceptable slippage; too loose invites
> **sandwich attacks** (a bot front-runs and back-runs the trade — a form of MEV). Frame this as a
> *mechanism* when a user asks why a swap "lost value," not as advice.

---

## 3. Impermanent loss — the LP concept everyone gets wrong

**IL is the value lost relative to simply holding the two tokens**, caused by the AMM mechanically
selling the rising asset and buying the falling one as the external price moves. It is "impermanent"
because it reverses if prices return to the entry ratio — and becomes **permanent the moment you
withdraw** at a diverged ratio.

The constant-product IL depends only on the **price ratio change** `r` (new price ÷ entry price),
*not* on direction:

```
IL = 2 * sqrt(r) / (1 + r) - 1        // negative = loss vs holding
```

| Price change of one asset vs the other | Impermanent loss vs holding |
|---|---|
| 1.25× | ≈ −0.6% |
| 1.5× | ≈ −2.0% |
| 2× | ≈ −5.7% |
| 4× | ≈ −20.0% |
| 5× | ≈ −25.0% |

**The LP's net result = fees earned − impermanent loss.** A pool is profitable for LPs only when
accumulated swap fees + incentives **out-earn** IL. Key framings to teach:

- **Correlated pairs have low IL** (StableSwap stable/stable, or an LST/ETH pair) — prices barely
  diverge, so IL stays tiny; that's *why* those pools exist.
- **Volatile/uncorrelated pairs have high IL** and need high fee volume or incentive emissions to
  compensate.
- **Concentrated liquidity amplifies both** fees (more capital at the active price) and IL (you're
  fully exposed within your range and "stop earning" when price exits it).
- A headline "200% APY" pool can still lose money once IL and the dumping of the incentive token are
  netted out — say this neutrally.

---

## 4. Lending, staking, yield — the three earn primitives

| Primitive | What you do | Where the yield comes from | Principal risk |
|-----------|-------------|----------------------------|----------------|
| **Lending (supply)** | Deposit an asset into a pooled money market (Aave/Compound). | Interest paid by borrowers; rate floats with utilization. | Bad-debt / liquidation-cascade / contract bug; small share-price-style accrual risk. |
| **Borrowing** | Lock collateral, borrow ≤ a limit (LTV). | (You pay this.) | **Liquidation** if collateral value falls past the threshold. |
| **Staking (PoS)** | Lock a chain's token to validate/secure it. | Protocol issuance + a share of transaction/priority fees. | Slashing (validator misbehavior), unbonding lockup, token price. |
| **Liquid staking** | Stake via a protocol that mints a receipt (stETH/rETH). | Same staking yield, but the LST stays tradeable/usable in DeFi. | LST **depeg** vs underlying, the staking protocol's contract risk. |
| **Yield farming / vaults** | Stack the above + incentive tokens, auto-compounded. | Base yield + emissions; aggregators rotate strategies. | Sum of every underlying risk + extra contract surface. |

**Lending mechanics to state precisely:**

- **Over-collateralization is the norm:** you must post *more* collateral than you borrow (e.g. 150%).
  There is no credit check — the collateral *is* the credit.
- **Utilization sets the rate:** `borrow rate` rises as the pool empties (more borrowed vs supplied);
  `supply APY ≈ borrow rate × utilization × (1 − reserve factor)`.
- **Liquidation** is automatic and on-chain: when collateral value / debt crosses the threshold, a
  liquidator repays the debt and seizes collateral at a discount. This is a *mechanism* to explain,
  not a thing to advise around.

**Staking nuances:**

- **APR vs APY again:** quote what the source quotes; if you compound, say "APY (compounded)".
- **Lockup / unbonding:** many PoS chains have an exit queue (days to weeks) — staked ≠ liquid.
- **Liquid staking trades lockup for depeg + extra contract risk** — name both sides.
- "Staking" on a centralized exchange is **custodial** (they hold the keys) — a different risk class
  from on-chain staking; don't conflate them. See [`onchain-and-wallets.md`](./onchain-and-wallets.md).

---

## 5. TVL — what it is, what it is NOT

**TVL = USD value of all assets currently deposited in a protocol** (or summed across a chain). It's
the industry's headline "size/adoption" metric.

| TVL is a decent proxy for | TVL is NOT |
|---|---|
| Relative scale / adoption of a protocol over time | Revenue, profit, or token value |
| Liquidity depth available to traders/borrowers | Locked-up-forever money (most is withdrawable any block) |
| A trend signal (inflows/outflows) | Double-count-free — restaking/LST/looping inflate it |

**TVL gotchas to flag neutrally:**

- **Denominated in USD**, so TVL falls when token prices fall even if no one withdrew — distinguish
  "price-driven" from "flow-driven" TVL change.
- **Double counting:** an asset staked → its LST deposited into lending → that receipt re-deposited
  can be counted three times. Good aggregators report a deduplicated figure; say which you're using.
- **Mercenary / incentivized TVL** chases emissions and leaves when they stop — high TVL ≠ sticky.

---

## 6. Free data sources for DeFi metrics

| Source | Gives you | Cost / key | Notes for Lumina |
|--------|-----------|-----------|------------------|
| **DefiLlama** | TVL by protocol & chain, yields (APY) via the `yields`/Pools API, stablecoin & DEX-volume datasets | **Free, no key**, generous | The default for TVL/yield; open API `api.llama.fi` / `yields.llama.fi`. Attribute "Data from DefiLlama". |
| **The Graph** (subgraphs) | Protocol-specific indexed on-chain data via GraphQL | Free dev tier; some subgraphs need a key | For pool-level/position data when DefiLlama is too coarse. |
| **CoinGecko** (already wired) | Token price/mcap (used to value TVL components) — **not** TVL itself | Demo key, `commercialOk:false` | Already in [`sources.ts`](../../../../backend/finance/sources.ts); pricing layer, not a DeFi metric source. |
| **Block explorer APIs** (Etherscan etc.) | Raw contract reads/balances | Free tier + key | Last resort; you'd compute TVL yourself. See [`onchain-and-wallets.md`](./onchain-and-wallets.md). |

**If you add a TVL/yield card to Lumina**, follow the *exact* finance contract — don't invent a new
pattern:

```ts
// Sketch ONLY — mirror the real fetchers in backend/finance/sources.ts.
// Returns frontend-ready data + a Provenance, fetched through getOrRefresh + a per-minute budget.
async function fetchTvl(protocolSlug: string) {
  const r = await fetch(`https://api.llama.fi/protocol/${protocolSlug}`); // free, no key
  if (!r.ok) throw new Error("defillama"); // throw → cache serves stale-on-error, never a fake 0
  const j = await r.json();
  return {
    tvlUsd: j.currentChainTvls,            // already deduplicated by DefiLlama
    provenance: {
      source: "DefiLlama",
      commercialOk: true,                  // DefiLlama's public API is free to use; STILL verify ToS before launch
      attribution: "Data from DefiLlama",
    },
  };
}
// Wire it like any finance card: getOrRefresh(`finance:tvl:${slug}`, 600, () => fetchTvl(slug))
// route via readRoute in routes.ts, add to the cron warmer. See finance lumina-finance-architecture.md.
```

> DefiLlama's API is free and broadly used commercially, but `commercialOk` is a **legal** flag, not a
> technical one — confirm the current ToS and keep attribution. Same discipline as CoinGecko: see
> finance `data-licensing-and-compliance.md`.

---

## 7. Risk framing — describe mechanisms, never give a verdict

DeFi stacks risks; an answer that names one and hides four is misleading. Surface the layers
**neutrally** (the same persona rule as the rest of finance: informational only, no buy/sell/hold).

| Risk layer | The mechanism (what to say) |
|------------|------------------------------|
| **Smart-contract** | A bug/exploit can drain the pool; audits reduce but don't remove this. Newer/unaudited = more surface. |
| **Impermanent loss** | LPs can underperform holding when prices diverge (§3); fees must out-earn IL. |
| **Liquidation** | Borrowers lose collateral automatically if its value falls past the threshold; cascades can move prices. |
| **Depeg** | A "stable" asset or LST can trade below its reference (USDC briefly did; UST collapsed); StableSwap pools are most exposed. |
| **Oracle** | Protocols price collateral via an oracle; a manipulated/stale oracle causes wrong liquidations or theft. |
| **Bridge** | Cross-chain assets rely on bridges, historically the single largest hack category. |
| **Governance / admin keys** | An upgradeable contract or multisig can change rules or, if compromised, rug the pool. |
| **Rug / honeypot** | Malicious token/pool: hidden mint, disabled sells, or a dev liquidity pull. Listing/price ≠ legitimacy. |
| **Yield sustainability** | High APY paid in an inflationary incentive token is often transient; net of token dump it can be negative. |

**The "is this yield real?" decision framework** (for explaining, not recommending):

```
A high advertised APY appears
|
+-- Where does the yield come from?
|     ├─ real fees/interest/issuance → more durable
|     └─ incentive-token emissions   → likely transient; net of token price + IL it may be negative
+-- What's the principal risk? (IL? liquidation? depeg? contract age/audit?)
+-- Is it APR or APY, gross or net of fees? → normalize before comparing
+-- TVL trend: sticky, or mercenary capital that leaves with the emissions?
+-- ALWAYS end: informational only — not financial advice.
```

---

## 8. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Calling IL "a fee" or "a loss only if the price drops." | IL is value vs *holding*, driven by price **divergence in either direction**; it's realized on withdrawal (§3). |
| Quoting a farm's headline APY as the return. | Net it against IL, fees, and incentive-token dilution; distinguish APR vs APY, gross vs net. |
| Treating TVL as money "locked up" or as revenue. | TVL is current USD of deposits, mostly withdrawable; it moves with token prices and is often double-counted (§5). |
| Saying a DEX/pool "can't be a scam — it has high TVL/price." | Listing, price, and TVL ≠ safety; describe rug/honeypot/oracle/admin-key mechanisms neutrally (§7). |
| Conflating on-chain staking with exchange "staking." | Exchange staking is **custodial** (they hold keys); on-chain staking is non-custodial with slashing/unbonding — different risk class. |
| Confusing market cap / FDV with TVL. | mcap/FDV are token-valuation metrics (see `crypto-asset-fundamentals.md`); TVL is deposited assets. Different numbers. |
| Inventing a TVL/APY figure from memory. | Source it from DefiLlama (free, no key) and state source + as-of time; on fetch failure serve stale, never a fake 0. |
| Flipping `commercialOk:true` because "DefiLlama is free." | Free access ≠ a display license confirmed; verify ToS, keep attribution. Same gate as CoinGecko (finance licensing ref). |
| Recommending a pool/vault "for good yield." | Never advise. Explain the mechanism + risks; end with "Not financial advice." |
| Treating a "stablecoin pool" as risk-free. | Stables/LSTs can **depeg**; StableSwap pools concentrate that exact exposure. Name it. |

---

## 9. Quick reference — formulas worth memorizing

```
AMM price (Uni v2):     price_X = reserve_Y / reserve_X      (k = x*y held constant)
Impermanent loss:       IL(r) = 2*sqrt(r)/(1+r) - 1          (r = price ratio change; negative)
LP net return:          fees_earned + incentives - IL
Lending supply APY:     ≈ borrow_rate * utilization * (1 - reserve_factor)
APR → APY:              APY = (1 + APR/n)^n - 1               (n = compounding periods/yr)
Market cap (NOT TVL):   circulating_supply * price            (see crypto-asset-fundamentals.md)
TVL:                    Σ (deposited_token_amount * token_price_usd)   (deduplicate restaking/LSTs)
```

**Where this connects in Lumina:** there's no DeFi code today; the closest live code is the CoinGecko
pricing layer in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) and the
`getCrypto` tool in [`backend/finance/tools.ts`](../../../../backend/finance/tools.ts). If you build a
DeFi/TVL surface, reuse that file's `Provenance` + `getOrRefresh` + per-minute budget contract
verbatim — the finance skill's `caching-and-rate-budgets.md`, `data-licensing-and-compliance.md`, and
`lumina-finance-architecture.md` are the build map. Keep all risk language **neutral** and end every
answer with the not-advice disclaimer (already stapled on tool results by `withGuard` in
[`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts)).
