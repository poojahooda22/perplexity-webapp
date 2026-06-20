---
name: equity-analysis
description: Analyze a single stock — fetch its quote (and recent news if relevant), explain the move and context neutrally, and present it WITHOUT giving buy/sell advice. Use when the user asks to analyze, break down, or give a view on a specific company or ticker.
---
# Equity analysis

When the user asks you to analyze a specific stock:

1. Call **getQuote** for the ticker to get current price, daily change, and % change.
2. If they ask *why* it moved or want catalysts/context, call **financeWebSearch** for recent
   news on that company (earnings, guidance, analyst actions, sector moves) and cite sources as [n].
3. Structure the answer:
   - One-line summary: price, today's move, and the headline reason if known.
   - **What's happening** — 2–4 bullets of the key drivers (cite [n]).
   - **Context** — valuation/sector framing in plain English (no price targets you can't source).
   - **Risks to watch** — neutral and factual.
4. State the as-of time for the price. Never say buy/sell/hold or whether it's a "good investment
   for you". End with "Not financial advice."
