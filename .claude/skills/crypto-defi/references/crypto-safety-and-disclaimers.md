# Crypto Safety & Disclaimers — high-risk framing, scam awareness, never advice

> How Lumina presents crypto **without giving advice and without endorsing**: reuse the finance
> persona's no-advice contract, lean on the `withGuard` `_disclaimer` staple that already rides on
> every object tool result, and describe scam / rug / phishing mechanisms **neutrally** (state the
> mechanism, never a verdict on a specific coin). Read this when you're writing or tuning crypto
> answer text, adding a crypto tool/skill, or reviewing a crypto reply for risk + legal cleanliness.
> `lumina-` ref = THIS codebase; cite the live file before you change it (line numbers drift).
>
> Sibling refs for adjacent topics: how to *read* CoinGecko fields (`lumina-coingecko-data.md`),
> the *concepts* behind those fields (`crypto-asset-fundamentals.md`), volatility/drawdown/liquidity
> mechanics to describe (`crypto-volatility-and-risk.md`), DeFi-specific risk (`defi-concepts.md`),
> prediction-market probability framing (`prediction-markets-deep.md`), and news/sentiment +
> republishing rules (`crypto-news-and-sentiment.md`). The *plumbing* (cache/budget/licensing gate)
> is in finance `data-licensing-and-compliance.md`; the *engine* in **ai-sdk-agent**.

---

## 1. Why crypto needs MORE than the finance disclaimer

The finance vertical already enforces "informational only — not financial advice" in two places:

1. **In the persona** — `FINANCE_PERSONA` in
   [`backend/prompt.ts`](../../../../backend/prompt.ts) (see the `## Rules` block): *"Informational
   ONLY — NOT financial advice. Never tell the user to buy/sell/hold and never give personalized
   suitability or allocation advice. End with a short 'Not financial advice.' line."*
2. **In the tool layer** — `withGuard` in [`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts)
   staples `_disclaimer: "Informational only — not financial advice."` onto every **plain-object**
   tool result (the `DISCLAIMER` constant; the staple is applied in `withGuard`'s post-call branch,
   skipping arrays/primitives). So the disclaimer rides back to the model on every `getCrypto`/
   `getQuote` result whether or not the model remembers to add it.

Crypto inherits BOTH for free (it routes through the same persona + the same `getCrypto`/
`fetchPredictions` tools). **But the finance disclaimer is necessary, not sufficient for crypto.**
Crypto carries failure modes equities do not: assets that are *engineered to steal* (rug pulls,
honeypots), an *irreversible-transfer* attack surface (phishing/approval drains, no chargeback), and
*no listing gate* (anyone can mint a token in minutes). Equity answers assume a regulated, vetted
security; crypto answers cannot. This ref is the crypto-specific layer **on top of** the finance
no-advice contract.

| Equity assumption | Crypto reality you must frame |
|-------------------|-------------------------------|
| Issuer is a vetted, regulated, audited entity. | Anyone can deploy a token; **listing ≠ legitimacy** (a coin on CoinGecko can still be a scam). |
| Transactions reverse (chargebacks, broker error correction). | On-chain transfers are **irreversible**; a wrong/phished tx is gone. |
| Custody is at a regulated broker/bank with insurance. | Self-custody means **you are the bank**; a leaked seed phrase = total loss, no recourse. |
| Price discovery is on deep, regulated exchanges. | Many tokens are **thin-liquidity** — the quoted price can be uncloseable size; a "10x" can be untradeable. |

---

## 2. The reuse pattern — do NOT re-author the disclaimer

The single source of truth for the not-advice string is `DISCLAIMER` in
[`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts). The persona ends answers with
"Not financial advice." Reuse, don't fork:

| Want to… | Do this (reuse) | NOT this (fork) |
|----------|-----------------|------------------|
| Disclaim a crypto tool result | Already done — `withGuard("getCrypto", …)` staples `_disclaimer`. Just keep new tools `withGuard`-wrapped. | Hand-append a disclaimer string inside the tool's `execute` (duplicates the constant; drifts). |
| End a crypto answer with the line | The persona already requires "Not financial advice." | Invent a longer crypto-specific legal block in prose every answer. |
| Add crypto-specific risk language | Put it in the **runtime** `crypto-research` skill playbook ([`backend/finance/skills/`](../../../../backend/finance/skills/)) so the model loads it via `loadSkill` only when relevant. | Bloat `FINANCE_PERSONA` with crypto paragraphs every query pays for. |

**Why the staple is on objects only:** `withGuard` guards `out && typeof out === "object" &&
!Array.isArray(out)` before spreading `{ ...out, _disclaimer }` — spreading into an array would
corrupt it (string keys on an array), and primitives can't take a property. So a tool that returns a
bare array or string gets **no** disclaimer. **Rule:** crypto tools must return a plain **object**
(`{ coins, provenance, fetchedAt, stale }`), never a bare array, or they silently lose the staple.

---

## 3. The framing contract — neutral, mechanism-not-verdict

The hard rule from this skill's SKILL.md Non-Negotiable #1: *surface scam/rug/phishing/liquidity
risk **neutrally** — state the mechanism, not a verdict.* Two failure directions to avoid:

- **Endorsement** ("this coin is safe / legit / a good buy") — that's advice + a liability if it
  rugs.
- **Accusation** ("XYZ is a scam") — defamation risk on a specific named project, and usually
  unprovable from the data we hold.

The safe register is **describe the mechanism + the observable signal + how a reader could check it**
— and let the reader judge. You are teaching what a rug *is* and what *would* indicate elevated
risk, not ruling on whether coin X is one.

| ❌ Don't say | ✅ Do say (neutral mechanism) |
|--------------|-------------------------------|
| "SafeMoonX is a scam, avoid it." | "A *rug pull* is when a token's creators drain its liquidity or dump a large pre-mined allocation, collapsing the price. Signals associated with elevated risk include unlocked/large insider allocations, no audited or locked liquidity, and anonymous teams — you can check token distribution on a block explorer and liquidity locks on the DEX." |
| "This coin can't be a scam, it's on CoinGecko." | "Being listed on a data aggregator means it has a market and tracked price — it is **not** a legitimacy review. Aggregators index thousands of tokens, including failed and malicious ones." |
| "Buy now before it moons." | "This is a high-volatility asset; prices can move sharply in either direction in minutes. Informational only — not financial advice." |
| "It's gone up 400%, it's clearly legit." | "Price appreciation is not evidence of safety; many rugs spike before collapsing. Sustainability depends on real liquidity, supply distribution, and demand — none of which a price chart alone shows." |
| "Send 1 ETH to this address to double it." (relaying a claim) | "Any offer to multiply funds you send is a classic **advance-fee / giveaway scam**; legitimate projects never ask you to send crypto to receive more back. On-chain transfers are irreversible." |

---

## 4. The scam taxonomy (what to be able to describe)

Keep these mechanisms in your back pocket so a crypto answer can flag risk concretely and neutrally.
Describe the *mechanism* and the *check*, never accuse a named asset.

| Scam / risk | Mechanism (one line) | Observable signal a reader can check |
|-------------|----------------------|--------------------------------------|
| **Rug pull** | Team removes liquidity or dumps insider supply, price → ~0. | Liquidity not locked; large unlocked team/treasury allocation; mint authority not renounced. |
| **Honeypot** | Contract lets you *buy* but blocks *sell* (or taxes it to 100%). | Token contract sell restrictions; near-zero unique sellers; use a honeypot checker / read the contract. |
| **Phishing / approval drain** | Fake site or signature tricks you into approving a token allowance the attacker then spends. | Unexpected approval prompts; look-alike domains; check + revoke approvals on an explorer's token-approval tool. |
| **Fake airdrop / dust** | Unsolicited tokens lure you to a malicious claim site that drains on connect. | Tokens you never bought appearing; "claim" links; never interact with unsolicited tokens. |
| **Giveaway / doubling** | "Send X, get 2X back" (often impersonating a brand). | Any request to send crypto first; impersonation handles. **Never possible.** |
| **Pump-and-dump** | Coordinated hype inflates a thin coin; insiders sell into retail. | Sudden volume + social spike on a low-liquidity, low-cap token. |
| **Pig butchering** | Long-con relationship → fake "investment" platform → can't withdraw. | Off-platform "guaranteed return" pitches; withdrawal fees that never end. |
| **Low-liquidity / slippage trap** | Quoted price is real but you can't exit at size without crashing it. | Thin order book / small pool TVL relative to market cap; high price impact on a test quote. |
| **Unlimited / hidden mint** | Owner can mint new supply at will, diluting holders to zero. | Mint function not renounced; supply not fixed; contract owner privileges. |

`crypto-volatility-and-risk.md` covers the *market* risks (volatility, drawdown, BTC correlation,
liquidity) in depth; `defi-concepts.md` covers DeFi-native risks (impermanent loss, smart-contract
exploit, oracle manipulation). This table is the **fraud/safety** slice.

---

## 5. The never-advice line — what's banned vs allowed

The boundary is the same as `FINANCE_PERSONA`'s, applied to crypto. The test: **am I telling THIS
user what to DO with THEIR money/portfolio (banned), or explaining how something WORKS (allowed)?**

| ❌ Advice (banned) | ✅ Informational (allowed) |
|--------------------|---------------------------|
| "You should buy Bitcoin / sell your ETH / hold SOL." | "Bitcoin's price is $X as of [time] per CoinGecko; here's how market cap is computed." |
| "Allocate 5% of your portfolio to crypto." | "Allocation depends on personal risk tolerance and goals — that's a question for a licensed advisor; here are the risk factors to weigh." |
| "This is a good entry point." | "The asset is down N% over 24h; entry timing is not something this assistant can recommend." |
| "Stake on protocol X for safe 12% yield." | "Staking locks tokens to secure a network / provide liquidity in exchange for rewards; 'yield' is not risk-free — slashing, lockups, and smart-contract risk apply." |
| "It's about to moon, get in." | "Short-term price moves are unpredictable; this is a high-volatility asset." |

When a user asks an advice question directly ("should I buy?"), the move is: **decline the
recommendation in one sentence, then pivot to the informational facts that help them decide** — and
end with the disclaimer. Do not stonewall; do not advise.

---

## 6. Decision framework — what does THIS crypto answer need?

```
Crypto question arrives
|
+-- Does it quote a price / mcap / supply / TVL / probability?
|     YES → must come from a tool (getCrypto / fetchPredictions) or a NAMED free API
|            (DefiLlama TVL, a block explorer). State source + as-of time. If {unavailable},
|            say live data is momentarily rate-limited — NEVER fabricate. (SKILL Non-Neg #4)
|
+-- Is it asking "is X safe / legit / a scam"?
|     → Describe scam MECHANISMS + checks neutrally (§3/§4). Never verdict on the named asset.
|       "Listing ≠ legitimacy; price ≠ safety." End with disclaimer.
|
+-- Is it an advice question (buy/sell/hold/allocate/timing/"good investment")?
|     → Decline the recommendation in ONE sentence (§5), pivot to informational risk factors,
|       end with "Not financial advice."
|
+-- Is it a prediction-market probability?
|     → It's the market's IMPLIED probability from current prices, not a forecast; check
|       provenance.unit (USD = Polymarket real money, mana = Manifold play money).
|       → prediction-markets-deep.md
|
+-- Is it about wiring/storing crypto safely (wallets/custody/seed)?
|     → Explain self-custody irreversibility + phishing surface NEUTRALLY; do not endorse a
|       specific wallet/exchange. → onchain-and-wallets.md
|
+-- Otherwise (concept explainer) → answer informationally; still end with the disclaimer
    if any risk/asset is discussed.
```

---

## 7. Tying it to the code — where each guarantee lives

| Guarantee | Enforced in | What to verify when you touch it |
|-----------|-------------|----------------------------------|
| Answer ends "Not financial advice." | `## Rules` of `FINANCE_PERSONA`, [`backend/prompt.ts`](../../../../backend/prompt.ts) | If you edit the persona, keep the no-advice + end-line rule intact. |
| `_disclaimer` rides on every object tool result | `DISCLAIMER` + `withGuard` post-call branch, [`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts) | New crypto tool returns a plain **object** and is registered as `withGuard("name", tool)`. |
| Scope guard (declines off-topic) | `FINANCE_PERSONA` opening lines, [`backend/prompt.ts`](../../../../backend/prompt.ts) | Crypto is in-scope ("markets, stocks, ETFs, crypto, indices, macro"); don't widen it to give advice. |
| No fabricated numbers | persona `## Tools` block + tools returning `{unavailable}` (see `lumina-coingecko-data.md`) | The tool must return a typed `{unavailable}` on rate-limit, never a throw posing as data. |
| Crypto-specific safety procedure | the **runtime** `crypto-research` skill `.md` in [`backend/finance/skills/`](../../../../backend/finance/skills/), loaded via `loadSkill` | Put scam-awareness steps THERE (per-task), not in the always-on persona. DESCRIBE that system; this dev skill does not author it. |

**Note on the `_disclaimer` staple's reach:** it's attached to the **tool result the model reads**,
not to the user-facing text. It guarantees the model is *reminded* on every tool round-trip; the
*visible* end-line still comes from the persona. Both layers matter — the staple is a belt; the
persona line is the suspenders. If you ever see a crypto answer missing the visible line, the bug is
in the persona path, not the staple.

---

## 8. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Calling a named coin "a scam" (or "safe/legit"). | Describe the rug/honeypot/phishing **mechanism** + the on-chain check a reader can run; let them judge. Verdicts = liability/defamation. |
| Answering "should I buy X?" with a recommendation. | Decline the recommendation in one sentence, pivot to risk factors + facts, end with "Not financial advice." |
| Hand-writing a disclaimer string inside a crypto tool's `execute`. | Let `withGuard` staple `_disclaimer` (single source = `DISCLAIMER` in `hooks.ts`); just wrap the tool. |
| Returning a bare array from a crypto tool. | Return a plain object (`{ coins, provenance, fetchedAt, stale }`) — arrays skip the `withGuard` staple. |
| Treating "it's on CoinGecko / price went up" as proof of legitimacy/safety. | Listing ≠ legitimacy; price ≠ safety. Aggregators index malicious tokens too. |
| Stuffing crypto safety paragraphs into `FINANCE_PERSONA`. | Put per-task safety steps in the runtime `crypto-research` skill (`loadSkill`); keep the persona lean. |
| Fabricating a market cap/supply/TVL to "complete" an answer. | Source it via tool or named free API + as-of time; if `{unavailable}`, say live data is rate-limited (SKILL Non-Neg #4). |
| Quoting Manifold odds as real-money probability. | Check `provenance.unit`: mana = play money; label it. → `prediction-markets-deep.md`. |
| Reassuring a user that self-custody/seed-phrase loss is recoverable. | State plainly: on-chain transfers are irreversible; a leaked seed = total loss, no chargeback. Neutral, not alarmist. |
| Endorsing a specific wallet/exchange/protocol as "the safe one." | Explain the custody/phishing trade-offs neutrally; recommending a specific product is advice. |

---

## 9. Output contract (what "done" looks like for a crypto answer)

A crypto answer (or a crypto tool/skill change) is done when:

1. **No advice:** no buy/sell/hold/allocate/timing language; advice questions are declined + pivoted.
2. **Neutral risk:** scam/rug/phishing/liquidity risk described as **mechanism + check**, never as a
   verdict on a named asset; no endorsement either.
3. **Numbers sourced:** every price/mcap/supply/TVL/probability comes from a tool or named free API
   with source + as-of time; `{unavailable}` on failure, nothing fabricated.
4. **Disclaimer present:** the visible "Not financial advice." line is there (persona), and any new
   tool is `withGuard`-wrapped and returns a plain object (so `_disclaimer` staples).
5. **Self-custody honesty:** if wallets/custody/seed phrases come up, irreversibility + phishing
   surface stated plainly and neutrally.
6. **Right home for procedure:** recurring crypto-safety steps live in the runtime `crypto-research`
   skill, not bloating the always-on persona.
