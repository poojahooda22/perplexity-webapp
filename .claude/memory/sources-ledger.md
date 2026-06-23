---
name: sources-ledger
description: "The single licensing source of truth — every data source the product touches, its fetch-path, the commercialOk verdict, and the governing ToS/statute clause. The PreToolUse guard and /sources-lint check against this."
type: reference
---

# Sources Ledger — the `commercialOk` truth table

> **The license attaches to the FETCH PATH, not the concept.** The US-Treasury 10Y from
> treasury.gov is GREEN; the *same number* from Yahoo's chart API is RED. `commercialOk:true` ⇔ the
> fetch path is public-domain / CC0 / CC-BY (with attribution) **or** a purchased display tier. A free
> API tier is **not** a display license. Default is `false`. See [`../rules/commercial-ok-gate.md`](../rules/commercial-ok-gate.md).
>
> Verdicts below were adversarially verified (2026-06-23, 25-agent research workflow) against primary
> ToS/statute text. **Re-confirm before flipping any gate.** When a ToS is silent/ambiguous on
> commercial redistribution or display, the verdict is RED, not GREEN.

Legend: 🟢 GREEN = displayable (public-domain/CC0/CC-BY + attribution, or licensed) · 🟡 YELLOW =
conditional/derived-data-license needed · 🔴 RED = not for public display on a free path ·
⛔ REJECT = ToS forbids the use outright (don't integrate).

## Market data (prices / quotes / indices / crypto)

| Source | Fetch path | Verdict | Governing clause (short) |
|---|---|---|---|
| Twelve Data (free) | `api.twelvedata.com` (key) — `getQuote` | 🔴 RED | Individual/Basic = "personal/internal" use; no third-party display/redistribution. |
| Yahoo chart API | `query*.finance.yahoo.com` — `getIndices` | 🔴 RED | No commercial-display grant; ToS forbids redistribution. |
| CoinGecko Demo | `api.coingecko.com` (demo key) — `getCrypto` | 🔴 RED | Demo scoped to personal use; "Powered by CoinGecko" required; redistributing data as your own = prohibited. |
| Finnhub (free) | `finnhub.io` — news/earnings | 🔴 RED for display | Free tier personal-use only; not for public display/redistribution. |
| FMP (free) | `financialmodelingprep.com` | 🔴 RED for display | Free tier non-commercial. |
| Tiingo | `api.tiingo.com` | 🔴 RED (unpriced) | "Data via the API is for internal consumption only… Redistribution only upon special request + ADDITIONAL FEES — contact sales." The published $250/mo tier is **internal-use only**, NOT a priced display SKU. |

## Prediction markets

| Source | Fetch path | Verdict | Governing clause (short) |
|---|---|---|---|
| Polymarket Gamma | `gamma-api.polymarket.com` `/events`,`/tags` — predictions | 🔴 RED | "Any rights not expressly granted… are reserved by PMUS"; no redistribution/display grant. Build the tabs (informational, attributed "Powered by Polymarket") but gate stays false until a written display agreement. **Geo-blocked from India/some egress — TCP hangs; keep the timeout + Manifold fallback.** |
| Manifold | `api.manifold.markets/v0` — fallback | 🔴 RED | Proprietary, personal-use; **play-money "mana"** — never render as USD. Has no tag taxonomy → category tabs degrade on fallback. |
| Kalshi | `api.elections.kalshi.com/trade-api/v2` | ⛔ REJECT | Data ToS bans non-commercial-only use, "providing archived or cached data sets," public display, scraping, AND any "machine learning and/or artificial intelligence" use. Caching + display + AI-blurb are all named prohibited. **Do not integrate.** |

## Government / public-domain (the GREEN spine)

| Source | Fetch path | Verdict | Governing clause (short) |
|---|---|---|---|
| SEC EDGAR | `data.sec.gov` (XBRL companyfacts/companyconcept/frames, `/submissions`) | 🟢 GREEN | Public domain (17 USC §105). Requires a descriptive `User-Agent` + ≤10 req/s fair-access. ⚠️ frames returns **duplicate/non-comparable facts** — a GREEN-but-wrong number still violates "never invent a finance number"; needs a dedup/restatement gate. |
| US Treasury | `home.treasury.gov` daily yield XML | 🟢 GREEN | US-gov public domain (17 USC §105). |
| BLS | `api.bls.gov` (LNS14000000 etc.) | 🟢 GREEN | US-gov public domain. |
| CFTC COT | Socrata API | 🟢 GREEN | US-gov public domain. (Futures-only, weekly ~3-day lag; positioning is a weak proxy.) |
| World Bank | `api.worldbank.org` | 🟢 GREEN | CC-BY 4.0 (attribution). |
| GDELT DOC 2.0 | `api.gdeltproject.org` — `fetchNewsSentiment` | 🟢 GREEN (conditioned) | "Unlimited and unrestricted… commercial use" **with mandatory verbatim citation + link** ("Source: The GDELT Project (gdeltproject.org)"). The condition must render on every surface that displays it, not just sit in the payload. Only the numeric tone is GREEN — underlying article headlines are third-party. |

## Hard RED traps (do not re-recommend for display)

| Source | Verdict | Why |
|---|---|---|
| FRED VIXCLS / 3rd-party FRED series | 🔴 RED | CBOE © / ICE © etc. — FRED *hosting* ≠ public domain. Only **Fed-owned** FRED series are GREEN. |
| Congressional trading (House Clerk PTR / Senate eFD / Quiver / Unusual Whales / Capitol Trades) | 🔴 RED by statute | 17 USC §105 (copyright public-domain) does NOT cure the **Ethics in Government Act 5 USC §13107(c)(1)**: unlawful to "use a report… for any commercial purpose, other than by news and communications media for dissemination to the general public" (civil penalty up to $10k). The "news media" carve-out is an untested affirmative defense, not a license. **Politicians tab = CUT** pending legal sign-off. |
| ApeWisdom / Reddit / StockTwits / X direct | 🔴 RED | No published ToS / non-commercial. |
| CME FedWatch / options-implied move | 🟡 YELLOW | CME-derived → needs a Derived-Data License to display. |

## Maintenance

- Adding a source? Add a row here **before** shipping it. `/sources-lint` audits code for
  `commercialOk:true` without a matching 🟢 row.
- The PreToolUse guard ([`../hooks/precheck-licensing.mjs`](../hooks/precheck-licensing.mjs)) nudges on
  any edit that introduces `commercialOk:true` — verify the fetch path is GREEN here first.
