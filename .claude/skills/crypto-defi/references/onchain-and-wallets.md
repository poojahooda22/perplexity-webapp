# On-chain & Wallets — addresses, chains, explorers, gas, custody

> What you must get *right* about the chain layer to answer "is this a real address?", "what
> network is this on?", "what did this transaction do?", "what's the gas?", and "is this wallet
> custodial?" — without fabricating, and knowing exactly which on-chain queries are free vs paid.
> Read this when a crypto task touches **addresses, EVM-vs-Solana, block explorers, free on-chain
> data, wallets/custody, or gas/fees.** Sibling refs cover adjacent ground: token *meaning*
> (coin vs token, market cap vs FDV, supply, stablecoins) → `crypto-asset-fundamentals.md`;
> DEX/AMM/pool/IL/staking/yield/TVL → `defi-concepts.md`; the CoinGecko *data plumbing* (our
> fetchers, the Demo key, `commercialOk`) → `lumina-coingecko-data.md` + finance
> `market-data-providers.md` / `data-licensing-and-compliance.md`.

This is **generic domain knowledge** — reusable on any chain task. It cites our code only where our
code already touches this surface (CoinGecko ids, the licensing gate, and one easy-to-confuse file).

> **DO NOT MIS-CITE:** [`backend/connectors/crypto.ts`](../../../../backend/connectors/crypto.ts)
> is **cryptography** (AES-GCM encryption of OAuth tokens), not **cryptocurrency**. Nothing on-chain
> lives there. Lumina holds **no private keys, signs no transactions, and queries no chain RPC** today
> — it reads CoinGecko market data ([`backend/finance/sources.ts`](../../../../backend/finance/sources.ts)).
> Everything below is the knowledge to *explain* on-chain concepts correctly and to wire a read-only
> on-chain source if one is ever added.

---

## 1. Addresses — what they are and how to validate one

An address is the public destination/identity on a chain, derived from a public key. **Never present
a string as an address without validating its shape for the chain in question** — a malformed or
wrong-chain address is the #1 way funds are lost, and it is cheap to catch.

| Chain family | Address shape | Validation | Case rule |
|---|---|---|---|
| **EVM** (Ethereum, L2s, BNB, Polygon, Avalanche C-chain…) | `0x` + 40 hex chars (20 bytes) | regex `^0x[0-9a-fA-F]{40}$`; for safety verify the **EIP-55 mixed-case checksum** | mixed-case *is* a checksum — don't lowercase it before display |
| **Solana** | base58, 32–44 chars, no `0x` | base58-decode → must be 32 bytes; an "address" is often a `PublicKey` | case-sensitive base58 (no `0`, `O`, `I`, `l`) |
| **Bitcoin** | `1…`/`3…` (legacy/P2SH) or `bc1…` (bech32 segwit) | bech32 / base58check checksum | bech32 is lowercase |
| **Cosmos / others** | bech32 with a chain prefix (`cosmos1…`, `osmo1…`) | bech32 checksum + expected prefix | lowercase |

**The same secret can produce the same address across all EVM chains** — one `0x…` works on
Ethereum, Arbitrum, Optimism, Base, Polygon, BNB. That is exactly why "which network?" is a separate
question from "which address?" (§2). A Solana address is a *different* keyspace and never collides
with an EVM one.

**ENS / SNS names** (`vitalik.eth`, `name.sol`) are human-readable aliases that resolve *to* an
address; they are not addresses themselves and resolution can change owner. Treat the name as a
lookup, the resolved hex/base58 as the truth, and show both.

---

## 2. EVM vs Solana — the two models you'll meet most

Most chains are one of two architectures. Knowing which one drives address shape, gas units, token
standards, and explorer/RPC choice.

| Dimension | **EVM** (Ethereum + the L2/sidechain galaxy) | **Solana** |
|---|---|---|
| Account model | Accounts + the EVM; contracts hold their own storage | Programs (stateless code) act on **separate account** data; SPL tokens live in per-owner token accounts |
| Address | `0x…` 20-byte hex (EIP-55 checksum) | base58 32-byte public key |
| Native gas token | ETH (or chain native: BNB, MATIC/POL, AVAX…) | SOL; fees in **lamports** (1 SOL = 1e9 lamports) |
| Fungible token standard | **ERC-20**; NFTs ERC-721/1155 | **SPL Token**; NFTs via Metaplex |
| "Chain id" | numeric `chainId` (1 = mainnet, 8453 = Base, 42161 = Arbitrum…) | network = mainnet-beta / devnet / testnet |
| Tx hash | 32-byte `0x…` | base58 signature |
| Finality / throughput | seconds; L2s batch to L1 | sub-second slots; very high TPS |
| Decimals | per-token (`decimals`, often 18; USDC = 6) | per-mint (often 6 or 9) |

**"Same token, different chains" is normal.** USDC exists natively or bridged on Ethereum, Solana,
Base, Arbitrum, Polygon, etc. — each is a **distinct contract/mint address** with its own liquidity.
A balance on Base ≠ a balance on Ethereum even though both say "USDC". When a user gives a contract
address, the chain is part of the identity; never assume mainnet Ethereum.

**Layer 2s are EVM** (Arbitrum, Optimism, Base, zkSync…). They inherit the `0x` address format and
ERC-20 standard but settle to Ethereum L1; gas is paid in ETH (or the L2's gas token) and is far
cheaper. Treat an L2 as "Ethereum-compatible, separate state, separate explorer."

---

## 3. Block explorers — the canonical read surface

A block explorer is the human-facing index of a chain: look up an address (balance, token holdings,
tx history), a transaction (status, from/to, value, gas, logs), a block, or a verified contract's
source. **Explorers are chain-specific** — pick by network, and link the user to the right one.

| Chain | Primary explorer | Notes |
|---|---|---|
| Ethereum mainnet | etherscan.io | the reference; family clones below share its API shape |
| Base / Arbitrum / Optimism / Polygon / BNB | basescan, arbiscan, optimistic.etherscan, polygonscan, bscscan | Etherscan-family; same URL/API patterns |
| Solana | solscan.io, explorer.solana.com, solana.fm | base58 sigs/addresses |
| Bitcoin | mempool.space, blockstream.info | also shows fee-rate market |
| Multi-chain | blockscout (self-hostable), Etherscan V2 multichain API | one key, many chains (V2) |

**How to use one in an answer:** to *verify* a claim ("did this tx confirm?", "what's this contract?")
link the user to the explorer and read it; never narrate an on-chain fact from memory. Explorers also
expose **JSON APIs** — but those are rate-limited and, on the free tier, governed by the provider's
ToS (see §5/§7). A "verified contract" badge means the source matches the deployed bytecode; it is
*not* a safety endorsement (verified code can still be malicious).

---

## 4. What an address/tx page tells you (and what it doesn't)

| You CAN read on-chain | You CANNOT read on-chain |
|---|---|
| Native + token balances, full tx history (public ledger) | The real-world identity behind an address (pseudonymous) |
| A tx's status, from/to, value, gas used, emitted logs/events | *Intent* — "was this a scam?" is inferred, never stated as fact |
| A contract's bytecode; verified source if published | Off-chain order books / CEX internal balances |
| Token transfers, approvals, contract interactions | USD price — that's an off-chain oracle/market feed (CoinGecko, §6) |

**Approvals are the under-appreciated risk surface:** an ERC-20 `approve` lets a contract spend your
tokens up to an allowance; a malicious or compromised contract with a standing approval can drain a
wallet later. When explaining wallet safety, name "revoke unused token approvals" — neutrally, as a
mechanism, never as advice.

---

## 5. Free on-chain data sources — what's free, what isn't

"Querying the chain" splits into three tiers. **Free key ≠ free for public display** — the same
licensing gate Lumina enforces for market data (`commercialOk`) applies to on-chain APIs too.

| Source type | Examples | Free tier reality | Good for |
|---|---|---|---|
| **Public RPC** (read the chain directly) | chain default RPC, Ankr, public Infura/Alchemy free, Solana mainnet-beta | low rate limits, no SLA, can rate-limit hard | `eth_getBalance`, `eth_call`, send-raw-tx, current block |
| **Explorer JSON API** | Etherscan(-family) V2, Solscan, Blockscout | free key, generous-ish but per-second capped; **ToS governs republishing** | tx history, token balances, verified source, gas oracle |
| **Indexed/analytics APIs** | Covalent/GoldRush, Alchemy enhanced, Helius (Solana), The Graph subgraphs, Dune | free tiers exist but small; rich queries are paid | wallet portfolios, decoded transfers, NFT metadata, aggregates |
| **Market/aggregate data** (off-chain) | CoinGecko, DefiLlama (TVL) | CoinGecko Demo = personal-use; DefiLlama free + open | prices, market cap, TVL — see `lumina-coingecko-data.md` / `defi-concepts.md` |

**RPC vs explorer-API — the decision:**

```
Need a chain fact?
|
+-- A specific current value (balance now, latest block, simulate a call)? --> public RPC (eth_call / eth_getBalance)
+-- History / decoded transfers / verified source / token list for an address? --> explorer JSON API (Etherscan-family / Solscan)
+-- Portfolio across many chains, NFT metadata, big aggregates? -----------------> indexed API (Covalent/Helius/The Graph) — mostly paid at scale
+-- Price / market cap / 24h / TVL (NOT on-chain — off-chain market data)? ------> CoinGecko / DefiLlama (our finance layer)
```

Raw RPC is "free" only at trivial volume and gives **raw** data (hex, no USD, no decoding). The
moment you need decoded history, USD valuation, or to *display* it publicly, you're into ToS +
rate-limit + paid-tier territory — exactly the trap documented for market data in finance
`data-licensing-and-compliance.md`.

---

## 6. On-chain data vs market data — keep them separate

A frequent error is treating "on-chain" and "price" as one thing. They live in different systems:

| | On-chain data | Market data |
|---|---|---|
| Source | RPC / explorer / indexer | CoinGecko, exchanges, DefiLlama |
| Examples | balances, tx history, supply on-chain, contract state | price, market cap, 24h %, volume, TVL |
| In our code | (none — Lumina queries no chain) | [`fetchCrypto`/`fetchCryptoMarkets`](../../../../backend/finance/sources.ts) (CoinGecko, lowercase **ids** not tickers) |
| Truth | the ledger | an aggregate of off-chain markets |

USD price is **not on the chain** — it's an oracle/market construct. So "what's ETH worth?" is a
CoinGecko question (our finance layer), while "how much ETH is in this address?" is an RPC/explorer
question. State the source either way; never blend them into one unsourced sentence.

---

## 7. Wallets & custody — the concept users most often confuse

A wallet is **a key manager, not a place where coins are stored**. Assets live on the chain; the
wallet holds the private key that authorizes spending from an address. The axis that matters is *who
controls the key*.

| Type | Who holds the private key | Examples | Trade-off |
|---|---|---|---|
| **Self-custodial / non-custodial** | the user | MetaMask, Phantom, Rabby, hardware (Ledger/Trezor) | full control; **lose the seed phrase = lose the funds, no recovery** |
| **Custodial** | a third party (exchange/app) | Coinbase/Binance balances, custodial fintech apps | recoverable login, but you trust the custodian (and "not your keys, not your coins") |
| **Hardware (cold)** | user, key never leaves the device | Ledger, Trezor | strongest against malware; less convenient |
| **Smart-contract / AA** | programmable (multisig, social recovery) | Safe (Gnosis), ERC-4337 account abstraction | recoverable + policies, but is itself a contract |
| **MPC** | key split across parties, never reassembled | Fireblocks, custodial-MPC apps | no single point of compromise; depends on the provider |

**Seed phrase = the keys.** A 12/24-word mnemonic (BIP-39) deterministically derives every key/address
in a self-custodial wallet. Anyone with the phrase has the funds; no one can reset it. The single most
important neutral safety fact to surface: a seed phrase is never legitimately requested by support, a
website, or an airdrop — that request *is* the phishing attack. State the mechanism, not advice.

**Lumina's stance:** the app is informational and **custody-free** — it never asks for, stores, or
handles keys/seed phrases, and never initiates a transaction. If a feature ever needs an address, take
it as a *read-only* input (validate per §1) and only ever *display* public chain data.

---

## 8. Gas & fees — what they are per chain

"Gas" is the fee paid to validators to include and execute a transaction. The unit and pricing model
differ by chain; get the units right or numbers are meaningless.

| Chain | Fee unit / model | Mental model |
|---|---|---|
| **Ethereum (EIP-1559)** | `gasUsed × (baseFee + priorityFee)`, priced in **gwei** (1e-9 ETH) | baseFee floats with demand and is **burned**; priorityFee ("tip") goes to the proposer |
| **EVM L2s** (Arbitrum/Optimism/Base) | small L2 execution fee + an L1 data/settlement cost | usually cents; the L1 data portion dominates |
| **Solana** | tiny base fee (lamports) + optional **priority fee** (compute-unit price) | fractions of a cent; priority fee buys ordering under load |
| **Bitcoin** | sat/vByte fee-rate market | you bid a fee rate; higher = faster inclusion |

Key facts to state correctly: gas scales with **computational work**, not USD value moved (a 1¢ and a
$1M ETH transfer cost similar gas); fees **spike with congestion**; a failed/reverted EVM tx **still
costs gas**; and gas is paid in the **native token** (you need ETH to move ERC-20s, SOL to move SPL
tokens). Quote gas in the native unit *and* note it's congestion-dependent — never as a fixed price.

---

## 9. Anti-patterns (mark an amateur)

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| Treating an address as chain-agnostic ("send to `0x…`"). | The chain is part of the identity. State the network; an EVM address works on many EVM chains but a token/contract is per-chain (USDC on Base ≠ on Ethereum). |
| Lower-casing an EVM address before showing it. | Mixed-case **is** the EIP-55 checksum; preserve it and validate the checksum to catch typos. |
| Validating a Solana address with the `0x` hex regex. | Solana is base58, 32 bytes, no `0x`. Use the right validator per chain (§1). |
| Narrating a balance / "the tx confirmed" from memory. | Read it on a chain-correct explorer or RPC; link the user to it; never fabricate a chain fact. |
| Quoting a coin's USD price as "on-chain data." | Price is off-chain market data (CoinGecko, our finance layer); on-chain gives balances/history, not USD. Keep §6 separate. |
| Calling a "verified contract" safe. | Verified = source matches bytecode, nothing more. Describe risk mechanisms (mint authority, unrevoked approvals, upgradable proxy) neutrally. |
| Saying "your coins are in your wallet." | Coins are on the chain; the wallet holds the **key**. Custody = who holds the private key (§7). |
| Treating a free RPC/explorer key as a public-display license. | Free key ≠ commercial display. The `commercialOk` gate applies to on-chain APIs too — check ToS before republishing (finance `data-licensing-and-compliance.md`). |
| Quoting gas as a fixed dollar amount. | Gas is congestion-dependent, in the native unit; baseFee floats. Quote the unit (gwei/lamports/sat-vByte) and note it varies. |
| Asking for / accepting a seed phrase or private key in any flow. | Lumina is custody-free, read-only. A seed-phrase request is the phishing attack — surface that neutrally, never request one. |
| Editing `backend/connectors/crypto.ts` for a "crypto" task. | That's AES-GCM token **cryptography**. Crypto-asset code is `backend/finance/sources.ts` + `tools.ts`. |

---

## 10. If we ever add a read-only on-chain source (checklist)

Lumina has none today. If a task adds one (e.g. "show the wallet's token balances"):

1. **Read-only, no keys.** Take an address as input; validate per §1 for the declared chain. Never
   sign or hold a key.
2. **Pick the right tier (§5).** Explorer JSON API for history/balances; RPC for a single current
   value; indexer for portfolios. Start with the smallest that answers the question.
3. **Go through our data layer.** Add a fetcher in [`sources.ts`](../../../../backend/finance/sources.ts)
   with a `Provenance` ({source, commercialOk, attribution}); flow through `getOrRefresh` + a per-minute
   budget exactly like the CoinGecko fetchers (see `lumina-coingecko-data.md` + finance
   `caching-and-rate-budgets.md`).
4. **Licensing gate.** Set `commercialOk` honestly from the provider's ToS — a free key is build/demo
   only until a paid display tier (finance `data-licensing-and-compliance.md`).
5. **Surface freshness + source.** Block/tx data has an as-of block/time; show it and the source,
   `unavailable` on rate-limit, never a fabricated value.
6. **Disclaimer.** Same not-advice framing as the rest of crypto; describe risk as mechanism.
