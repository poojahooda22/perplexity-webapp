---
name: crypto-research
description: Research a cryptocurrency — fetch its market data and recent news, explain what it is and what's driving it, and frame risk neutrally. Use when the user asks to research, analyze, or explain a specific crypto asset, or to compare coins.
---
# Crypto research

When the user asks about a specific crypto asset (or to compare a few):

1. Call **getCrypto** with the CoinGecko coin id(s) (e.g. bitcoin, ethereum, solana) for price,
   24h change, and market cap.
2. If they want context or "why is it moving", call **financeWebSearch** for recent crypto news
   and cite [n].
3. Structure the answer:
   - One-line summary: price, 24h move, and market-cap size.
   - **What it is** — one or two sentences (skip if obvious, e.g. BTC/ETH).
   - **What's driving it** — recent catalysts (cite [n]).
   - **Risk note** — volatility, liquidity, and regulatory factors, neutral and factual.
4. State the as-of time. Crypto is highly volatile — never give buy/sell advice. End with
   "Not financial advice."
