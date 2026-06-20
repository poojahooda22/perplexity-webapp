---
name: market-overview
description: Give a daily US market overview — index levels, notable movers, and the macro headlines driving the day. Use when the user asks how the markets are doing, for a market recap, or "what's moving today".
---
# Market overview

When the user asks for a market overview / recap / "how are the markets":

1. Call **getIndices** for the S&P 500, NASDAQ, Dow, and the VIX.
2. Call **financeWebSearch** for today's market-moving headlines (the Fed, rates, big earnings,
   macro/oil) and cite [n].
3. Optionally call **getQuote** for a few megacaps if they're central to the day's story.
4. Structure the answer:
   - One-line summary: are indices up or down, and the headline reason.
   - **Indices** — a short table or bullets with level + % change.
   - **What's driving it** — 2–4 bullets (cite [n]).
   - **Volatility** — what the VIX level says in plain English.
5. State the as-of time. End with "Not financial advice."
