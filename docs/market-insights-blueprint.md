# Lumina Market Insights — Implementation Blueprint

> **Status:** research complete, build-ready. Produced 2026-06-23 from a 3-phase multi-agent research loop
> (competitive sweep of 14 financial-services firms → data-contract + codebase-grounded design → assembled
> blueprint), with two completeness-critic passes. The second critic verdict: *"implementation-complete on
> architecture"* — the four residual schema/contract items (B1–B3, S3) are resolved in **Part D** below.
>
> **Brand rule:** the product is **Lumina**; the columnist persona is **"The Lumina Tape."** Never write
> "Perplexity" in user-visible text. Competitor names below are internal analysis only.
>
> **Cross-cutting contracts (hold throughout):** never invent a number (tools fetch, model grounds, failed
> tools → typed `unavailable`/`needsKey`); every displayed series carries `Provenance{source, commercialOk,
> attribution}`; finance prose is informational only — "Not financial advice."; relative backend imports use
> explicit `.js`; new backend files need a full dev-server restart.

---

## Part A — Strategy & competitive frame

### The verdict that governs everything
JPMorgan's market-insights product (Global Data Assets & Alpha Group — Market/Data/Positioning Intelligence)
is **institutional-only, entitlement-gated**, and its true moat is the **Prime-brokerage book** (real
hedge-fund long+short exposure and leverage off ~$1T balances) — which **no public source publishes and no
free app can replicate**. We do **not** fight on data exclusivity. We win on the axis the incumbents are
structurally weakest on: **a free, conversational, fully-cited AI layer over public-domain data** — the part
MiFID II already commoditized at institutions, that retail has *never* had.

> **Positioning:** *Lumina turns the institutions' gated, quarterly-stale, take-our-word-for-it market
> insights into a free, live, fully-cited research conversation — the Guide to the Markets you can argue with.*

### Master feature inventory (deduped across 14 firms — 8 clusters)
Every serious player ships ~the same skeleton; they differ on *data moat* (we can't match) and *delivery* (we beat):
**A. Daily briefing** (pre-open desk note · fixed-skeleton weekly · named-voice columnist · multi-format) ·
**B. Sentiment & positioning** (composite fear/greed dial · survey sentiment · crowding · news/social attention) ·
**C. Scenario/regime/macro** (regime classifier · recession signals · econ calendar · prediction-market odds) ·
**D. Sector & single-stock** (treemap · ticker page · price-move timeline · ratings · earnings hub) ·
**E. Screening/discovery** (screener · NL screener · comparison grid) ·
**F. Alt-data signals** (congress/insider trades · contracts/lobbying · flows · retail buzz) ·
**G. Conversational AI** (cited Q&A · doc/transcript RAG · 3-bullet summaries · agentic research w/ audit trail) ·
**H. Alerts & proactive delivery** (event push · scheduled research · personalized digest).

### The "substance ON TOP of the briefing" that beats them for retail (prioritized)
**P0 (ship with the wedge):** (1) **every number tappable to its source + datum** — inline `[n]` + per-datum
Provenance badge — the single biggest differentiator (JPM asserts with no link); (2) **the briefing is a chat
thread, not a static PDF** — the dial, every heatmap tile, every grade is a clickable seed into the same cited
agent ("why is sentiment Extreme Fear?", "show me 2008", "what if the Fed cuts?"); (3) **fixed scannable
skeleton daily** (steal BlackRock BII verbatim); (4) **a named AI-columnist persona** ("The Lumina Tape");
(5) **watchlist personalization** pushed via the Gmail connector + cron.
**P1 (fast-follow):** the "why" attribution chain on the dial · cross-firm **consensus range** instead of one
house call · explicit **bull/bear/consensus** triangulation with an invalidation block · behavioral-coaching
("missing the 10 best days") · breaking-news lightning-bolt.
**P2 (moat-builders):** a **public track-record scorecard** (no bank shows you their miss rate) · a weekly
user-poll flywheel · multi-format (TTS podcast) · **cross-vertical synthesis** (biotech ticker → its clinical
trial/paper via Lumina's Academic/OpenAlex feed — unique to our multi-vertical shape).

### Why we win (4 structural advantages the incumbents can't retrofit)
1. **Free, at the surface they paywall.** 2. **Conversational & interactive over static.** 3. **Cited &
auditable by construction** (never-invent-a-number + per-datum provenance) + an honest public scorecard.
4. **Cross-firm + cross-vertical synthesis** no single firm (with products to sell) offers.

---

## Part B — The launch-safe data spine (the licensing crux)

**The rule that resolves the whole project: the license attaches to the FETCH PATH, not the concept.**
"Treasury 10Y" is GREEN only from Treasury's own API; the same number from Yahoo `^TNX` is RED.
`commercialOk:true` ⇔ fetch path is public-domain/CC0/CC-BY **or** a purchased display tier.

| # | Series | Path Lumina uses | Verdict | `commercialOk` | Launch-safe today? |
|---|---|---|---|---|---|
| 1 | US Treasury yields / par curve | `home.treasury.gov/...xml?data=daily_treasury_yield_curve` + `api.fiscaldata.treasury.gov` | 🟢 GREEN | true | ✅ |
| 2 | SEC EDGAR (XBRL, submissions, Form 4) | `data.sec.gov`, `efts.sec.gov`, `www.sec.gov/Archives` | 🟢 GREEN (UA + ≤10 rps) | true | ✅ |
| 3 | CFTC COT (positioning) | Socrata `publicreporting.cftc.gov/resource/6dca-aqww.json` | 🟢 GREEN | true | ✅ |
| 4 | GDELT DOC 2.0 (news tone/volume) | `api.gdeltproject.org/api/v2/doc/doc` | 🟢 GREEN (mandatory citation+link) | true | ✅ |
| 5 | BLS U-3 (LNS14000000) → Sahm | `api.bls.gov/publicAPI/v2/timeseries/data/` | 🟢 GREEN | true | ✅ |
| 6 | NY-Fed recession probit (self-computed) | computed from #1 spread | 🟢 GREEN | true | ✅ |
| 7 | Strategist consensus range (extracted facts) | Tavily → `generateObject` → attributed facts | 🟢 GREEN-w/guardrails | false beyond bare fact | ✅ (guardrails) |
| 8 | Congress trades (House PTR / Senate eFD) | `disclosures-clerk.house.gov`, `efdsearch.senate.gov` | 🟢 GREEN (primary record) | true | ✅ (PDF-parse caveat) |
| 9 | USAspending contracts | `api.usaspending.gov/api/v2/` | 🟢 GREEN | true | ✅ |
| 10 | Senate LDA lobbying | `lda.gov/api/v1/` | 🟢 GREEN + disclaimer | true | ✅ |
| 11 | **Lumina Market Mood** (composite) | self-computed | 🟢 GREEN *iff every input GREEN* | true if all-green inputs | ✅ (green-input build — see S3) |
| 12 | HYG/LQD credit spread | Yahoo chart | 🟡→RED until licensed | false | ❌ defer/substitute |
| 13 | CoinGecko breadth/dominance | Demo tier | 🟡 (Basic ~$35/mo flips it) | false→true on paid | ⚠️ paid flip |
| 14 | Yahoo chart (indices/VIX/sectors/rates spine) | `query1.finance.yahoo.com/v8/finance/chart` | 🔴 RED **permanent** | false | ❌ build/demo only |
| 15 | CBOE VIX value + put/call ratio | cboe.com / Yahoo `^VIX` / FRED VIXCLS | 🔴 RED | false | ❌ omit at launch |
| 16 | FRED (as a *display* source for proprietary series) | `api.stlouisfed.org` | 🔴 RED (no-cache ToS + proprietary) | false | ❌ discovery only |
| 17 | AAII / NAAIM sentiment | aaii.com / naaim.org | 🔴 RED | false | ❌ omit |
| 18 | ApeWisdom (Reddit WSB) | apewisdom.io | 🔴 RED (Reddit wall) | false | ❌ omit (use GDELT) |
| 19 | Polymarket / Manifold odds | gamma-api / api.manifold | 🔴 RED | false | ❌ link-out only |

**The Mood contamination rule:** the composite is your own IP but inherits the **most-restrictive input
license**. One RED input (CBOE put/call, VIX, Yahoo equity prices) makes the whole dial RED. → see **S3**.

### Endpoint contracts for the Phase-1 (GREEN) set
- **Treasury par curve:** `GET .../pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=YYYY` → OData XML;
  fields `d:NEW_DATE, d:BC_3MONTH, d:BC_2YEAR, d:BC_10YEAR`. `spread_10y2y = BC_10YEAR−BC_2YEAR`,
  `spread_10y3m = BC_10YEAR−BC_3MONTH`. No key, ~1×/day, posted ~4 PM ET. Attribution: "Source: U.S. Dept. of the Treasury."
- **BLS U-3 → Sahm:** `POST api.bls.gov/publicAPI/v2/timeseries/data/` `{seriesid:["LNS14000000"],startyear,endyear,registrationkey}`.
  `sma3=mean(u[t..t-2]); low12=min(sma3 over prior 12mo); sahm=sma3−low12; trigger≥0.50`. Free key (500/day v2; 25/day v1 keyless fallback). ~1st Friday 8:30 ET.
- **NY-Fed recession probit (self-computed):** `P = Φ(α + β·spread_10y3m)`, `α=−0.5333`, `β=−0.6629`, `Φ(x)=0.5·erfc(−x/√2)`.
  Sanity: spread 0 → ~30%, −1.0 → ~55%, +2.0 → ~3%. Attribution: "Estrella–Mishkin (1998) probit." Never label it the NY-Fed official series.
- **GDELT DOC 2.0:** `GET api.gdeltproject.org/api/v2/doc/doc?query=<scoped>&mode=timelinetone&format=json&timespan=3m&timelinesmooth=5` (+ `mode=timelinevol`).
  Keyless, **per-IP throttle (exact QPS unpublished)** → server-side + cache only, ~2 GET/market/day, 429-backoff. Mandatory verbatim attribution: `Source: The GDELT Project (gdeltproject.org)` + link.
- **CFTC COT:** `GET publicreporting.cftc.gov/resource/6dca-aqww.json` (Socrata; optional free app token). Weekly Fri 3:30 ET. Public domain.
- **SEC EDGAR / Form 4:** discovery `efts.sec.gov/LATEST/search-index?...&forms=4`; per-CIK `data.sec.gov/submissions/CIK##########.json`; doc XML `<ownershipDocument>`. **Hard gates: descriptive `User-Agent` + ≤10 rps aggregate (shared Redis token bucket — see S1).** Public domain.

**Launch-safe TODAY, zero spend, zero contracts:** Treasury · GDELT · CFTC COT · SEC EDGAR/Form 4 +
Congress/USAspending/LDA · BLS→Sahm + self-computed probit · **Lumina Market Mood from GREEN inputs only.**
**Needs a paid tier/substitute (NOT in public v1):** equity index/sector/VIX levels (replace Yahoo-RED with an
FMP commercial Data-Display license or omit VIX / substitute self-computed realized vol) · HYG/LQD spread ·
crypto breadth (CoinGecko Basic ~$35/mo) · AAII/NAAIM/Reddit/Polymarket (omit or link-out).

---

## Part C — The build (grounded in the live code)

### C1. Persistence layer (new — none exists today)
Nine models + two enums. Live schema currently has only User/Conversation/CachedQuery/Message/GmailConnection.

```prisma
model DailyOHLC {
  ticker String
  date   DateTime @db.Date
  o Float
  h Float
  l Float
  c Float
  v BigInt                        // ETF/index daily volume exceeds Int32; Number()-cast before JSON (B3)
  source String  @default("yahoo")
  asOf   DateTime @default(now())
  @@id([ticker, date])
  @@index([date, ticker])          // load-bearing: breadth scan = WHERE date=$1 range seek (R-SCALE §A)
  @@map("daily_ohlc")
}
model SP500Constituent { ticker String; name String; sector String; weight Float?; asOf DateTime @db.Date; @@id([ticker, asOf]); @@index([asOf, sector]); @@map("sp500_constituent") }
model MarketMoodReading { date DateTime @id @db.Date; score Float; label String; breadth Float?; momentum Float?; volatility Float?; strength Float?; safeHaven Float?; components Json?; asOf DateTime @default(now()); @@map("market_mood_reading") }
model SentimentReading { ticker String; date DateTime @db.Date; score Float; confidence Float; source String; asOf DateTime @default(now()); @@id([ticker,date,source]); @@index([date,ticker]); @@map("sentiment_reading") }
model HouseViewCall {
  id String @id @default(uuid())
  signalKey String @map("signal_key")    // "market_mood.us" | "recession.us.12m"
  market String @default("us")
  claim String
  direction CallDirection @default(neutral)
  predictedProb Float? @map("predicted_prob")
  threshold Float?
  inputsSnapshot Json @map("inputs_snapshot")  // point-in-time features — Number()-cast BigInt before build (B3)
  refValue Float? @map("ref_value")
  madeAt DateTime @default(now())
  resolveAt DateTime @map("resolve_at")
  status CallStatus @default(open)
  outcomeValue Float? @map("outcome_value")
  correct Boolean?
  resolvedAt DateTime?
  notes String?
  evidence Json?
  @@index([signalKey, market, status]); @@index([resolveAt, status]); @@index([madeAt]); @@map("house_view_call")
}
model Watchlist { userId String @id; symbols Json; market String @default("us"); briefingEmail Boolean @default(false); updatedAt DateTime @updatedAt; createdAt DateTime @default(now()); user User @relation(fields:[userId],references:[id],onDelete:Cascade); @@map("watchlist") }
model Briefing {
  id String @id @default(uuid())
  userId String
  forDate String                   // "2026-06-23" — string key for the @@unique idempotency
  body String
  emailedAt DateTime?
  createdAt DateTime @default(now())
  user User @relation(fields:[userId], references:[id], onDelete:Cascade)   // B1: FK + cascade (matches GmailConnection/Watchlist)
  @@unique([userId, forDate])      // idempotent fan-out: no double-gen / double-send
  @@map("briefing")
}
model CardEvent {
  id String @id @default(uuid())
  userId String?                   // B1: BARE, nullable — intentional. High-write append-only analytics;
                                   // no FK/cascade (avoids write contention; retains anonymized events post-delete).
  cardType String
  cardKey String
  event String
  surface String
  createdAt DateTime @default(now())
  @@index([userId, createdAt]); @@index([cardType, event]); @@map("card_event")
}
enum CallDirection { bullish bearish neutral up down event_yes event_no }
enum CallStatus    { open resolved void }
```
**Back-relations on `User`:** `watchlist Watchlist?` · `briefings Briefing[]`. (B1: see Part D.)

**Nightly ingest** — `backend/finance/ingest.ts`, a `CRON_SECRET`-guarded route (NOT the Fly worker, NOT a timer):
`ingestConstituents()`, `ingestDailyOHLC({full?,cursor?})`, `computeMarketMood(date)`, `resolveHouseViewCalls(now)`.
Fetch per-symbol via existing `fetchYahooQuote` (`range=1y` backfill); write bulk via `createMany({skipDuplicates})`
single-day, or `$executeRaw INSERT … ON CONFLICT (ticker,date) DO UPDATE` for corrections. Chunked+resumable
(`CHUNK=50`, cursor in Upstash, 50s soft-deadline). Heavy derived work (mood compute, call resolution) runs here, off the read path.

### C2. The generation pipeline — tool-grounded daily briefing
Today's `summary.ts`/`research.ts` are single-shot `generateObject` over Tavily snippets — every "number" is whatever
the LLM copied (**violates rule #1**). The briefing runs the same tool loop the finance chat uses, in **two phases, one evidence set**:
- **Phase 1 GATHER (tool loop, prose discarded):** `streamText` + the briefing tool belt, `stopWhen: stepCountIs(8)`;
  keep only the typed `EvidenceLedger` the tool factory accumulates (reuses cache, in-flight de-dupe, per-minute vendor budget, typed `unavailable`, `commercialOk`).
- **Phase 2 WRITE (`generateObject`):** feed the ID-tagged ledger as a numbered context block into one `generateObject`
  over the fixed 7-section Zod schema; the model may only cite ledger `ref`s; `validateBriefing` rejects/repairs any untraceable number.

**Files:** NEW `backend/finance/{briefing,briefing-tools,sentiment-sources}.ts`; EDIT `prompt.ts` (+`BRIEFING_COLUMNIST_PERSONA`,
`BRIEFING_GATHER_SYSTEM`), `lib/wire.ts` (+`briefingTail`, `<BRIEFING>` strip rule), `finance/routes.ts`, `index.ts`.

**7-section schema** (one schema, render order = section order): `marketTake{mood,headline,body}` → `bottomLine` →
`whatMoved[2..5]{driver,why}` → `sentimentRead{gauge,body}` → `crossAssetLevels[4..10]{asset,level,change,ref}` →
`catalystsToday[1..6]{when,event,note}` → `onInvestorsMinds[2..4]{question,take}` → `followUps[5]`. Every `Claim`
= `{text, refs[]}` where `refs` are ledger ref ids backing every NUMBER.

**Provenance wiring — two shapes, one ledger:** `NumberFact{kind:"number",ref:"T*",tool,label,value,source,commercialOk,fetchedAt,stale}`
(a tool-sourced number) vs `ClaimSource{kind:"web",ref:"S*",n,title?,url,snippet?}` (the inline `[n]`). Refs assigned
**in the tool factory closure**. `validateBriefing(b,ledger)` regex-extracts numerals from text/level/change and asserts each
is covered by a `T*`, and every `[n]` maps to an `S*` → the runtime enforcement of never-invent-a-number.

**Dual render from ONE cached generation:** homepage card = cached `BriefingResult` JSON (no LLM, no parse); chat thread =
`briefingToMarkdown(briefing,ledger)` streamed via `res.write` from the same `getOrRefresh` generation (can't drift from the card);
follow-ups fall through to the normal `streamFinanceAnswer` tool loop. Persona = a sibling of `FINANCE_PERSONA`, not a replacement.

### C3. Safety — no-advice guard + numeric verification
Both install at **one checkpoint:** `verifyFinancePresentation()` on the buffered answer **before** `persistTurns`/`res.end()`
(chat) and inside the `generateObject` wrappers (briefings). Gates persistence+cache, not the optimistic token stream.
Files: `backend/finance/guards/{no-advice,numeric-grounding,verify,lexicon}.ts` + tests.
- **No-advice (two-layer):** Layer A = deterministic anchored regexes for reader-directed imperatives (`you (should|must)
  (buy|sell|short|hold)`, `I (recommend|advise)`, `(put|allocate) N% (of your|into)`, personalized targets) — `block` is
  conclusive; Layer B = a haiku-4.5 judge only when A flags. **The boundary = directionality + addressee + modality, NOT topic:**
  scenario framing ("Bull case: if X holds above $Y…") and invalidation levels ("invalid below $182") are ALLOWED; second-person
  imperative transaction verbs are BLOCKED. Actions: `ok`→cache; `warn`→redact+annotate, don't cache; `block`→regenerate once, else safe placeholder.
- **Numeric grounding:** default deterministic extract-and-diff (tokenize numerals, classify, diff `direct` numbers vs the tool
  dataset with tolerance; recompute candidate derivations; scenario numbers exempt; ungrounded `direct` → strip-and-annotate).
- **Cost:** briefings = deterministic-only (no judge), saves ~$140/mo; chat = lexicon gates the judge (clean answers cost $0 extra);
  judge on haiku-4.5; cache verdicts by answer-hash. **Net added spend: single-digit $/month.**

### C4. Signature artifacts (each ships its honesty treatment)
A predictive element renders only with a `Calibration{status,brier,historicalHitRate,sampleSize,scorecardUrl,...}`
(`MIN_SAMPLE=8`); otherwise the UI strips the predictive verb → "No track record yet — descriptive only."
- **Market Mood dial (Phase-1 GREEN build):** equal-weight composite of green sub-signals — Treasury 2s10s/3m10y spread,
  GDELT tone z-score, CFTC net positioning, self-computed 30-day realized vol (substituting VIX), McClellan-*style* breadth
  proxy. Per-signal **252-day rolling z-score** → `clamp(50+50·z/3,0,100)` → mean → 0–100. Buckets <25 Extreme Fear … ≥75
  Extreme Greed. Look-ahead guard: current bar excluded from its own baseline. Honesty: never call it "CNN Fear & Greed";
  "Lumina Market Mood — a sentiment composite" + "how it's computed". **(See S3 for the launch-green scoping.)**
- **Recession panel:** self-computed Estrella–Mishkin probit over the Treasury 3m10y spread + the Sahm value. Present a
  **calibrated probability, not a verdict.** Mandatory copy: "8-of-8 recessions preceded by inversion, ~1 false positive";
  the 2022–24 inversion is a **resolved MISS in the scorecard**, named in prose AND absorbed into the displayed hit-rate.
- **GDELT "Bull/Bear Buzz":** `timelinetone`+`timelinevol`, 90-day rolling z-score → −100…+100, **buzz shown as a SEPARATE
  dial** (tone correlates with coverage volume — the honesty mechanism). `commercialOk:true` w/ verbatim GDELT citation.
- **Alt-data:** Congress (House `<YEAR>FD.zip→.xml`, filter `FilingType=P`, per-doc PDF parse → `unavailable` on failure) ·
  Insider Form 4 (structured XML, ~2-day lag, highest quality) · USAspending×LDA "Behind the Curtain" · ETF flow proxy
  (`(sharesOut_t−sharesOut_{t-1})·NAV` per-issuer, YELLOW). **Never scrape Quiver/Capitol-Trades** — parse primaries.
- **Consensus range:** Tavily discovery → one `generateObject` extraction → dedup to latest per `(firm,subject,horizon)` →
  `low/high/median/mean/n`. Anti-fabrication: drop any target whose value isn't literally in its `quoteSpan`. Legal basis:
  Feist + Barclays v. Theflyonthewall + Lowe v. SEC — attributed, public, already-reported targets, firm **name only (no logo)**,
  impersonal, standing disclaimer. Attribution: `"<Firm> · <value> · <horizon> · as of <date> · via <Publisher> ↗"`.
- **The scorecard (the moat):** `emit-calls` cron snapshots a falsifiable `HouseViewCall` before the outcome is knowable;
  `resolve-calls` grades due calls by a **mechanical close lookup (independent verifier, never an LLM)**; the same resolved
  numbers gate the live dial, so dial and scorecard can never disagree. **Misses are shown, not filtered.**

### C5. Routes / cron / cache / scale
New GET routes reuse `readRoute`/`marketReadRoute` verbatim: `/finance/{mood,recession,sentiment,gdelt,briefing,scorecard}`
+ `POST /finance/scenario` (cache on input-hash). TTLs by cadence: mood 3600 / recession 21600 / sentiment 1800 / gdelt 3600 /
briefing 1800 / cot 604800 / 13f 86400. Add the shared LLM surfaces to `WARM_JOBS`. Factor the inline `CRON_SECRET` block into a
reusable `cronGuard`. Separate crons so slow feeds don't ride the 1-min loop: `refresh` (1 min, existing) · `refresh-slow`
(COT/13F, daily) · `ingest` (post-close) · `emit-calls` (daily+monthly) · `resolve-calls` (daily) · `briefing` (nightly, enqueue only).

**Personalized briefing = queue fan-out** (per-user, NOT shared-cacheable): cron pages `Watchlist where briefingEmail OR active`
→ `LPUSH briefing:queue:<date>` → **existing Fly worker** `RPOP` → check `@@unique(userId,forDate)` → cached/batched quotes +
hot `sentiment`/`gdelt` → `generateObject(haiku)` → `INSERT Briefing` → idempotent `sendGmail` if `emailedAt` null.

**R-SCALE tier verdict:** shared mood/recession/sentiment/gdelt/briefing/scorecard = **Tier 3** (one flyer cached + SWR +
cron-warmed; reads scale independently of writes). Per-user quote fetch = Tier 2 via shared cache + batched dedupe. **S&P-500
breadth on free Twelve Data = Tier 1** (needs paid/bulk EOD + the `Constituent` DB to reach Tier 3). Personalized fan-out =
Tier 1–2 launch-capped — the ceilings are **cost + Google verification, not code** (queue + `@@unique` is already Tier-3-shaped).

**LLM cost:** ~$0.0035/personalized briefing → 1k users ≈ $105/mo (trivial); **100k ≈ $350/night ≈ $10.5k/mo** + 100k Gmail
sends — the number the rule forces us to write down, and why this leg does NOT launch at Tier 3. Mitigate: fan out over **MAU
not total**, cluster similar watchlists, batch overlapping quotes. **Gmail send IS wired** (`gmail.send` in `GMAIL_SCOPES`,
`sendGmail`); recommend **dropping `gmail.readonly`** from the briefing grant so the email leg is send-only (SENSITIVE, no CASA audit).

### C6. Frontend (`frontend/src/components/finance/`)
`InsightCard` (generic shell: header + provenance chip + freshness + "Explain"/"Ask" footer; reads `predictiveOk`/`commercialOk`) ·
`MoodDial` · `RecessionPanel` · `BuzzDial` (two side-by-side dials, never blended) · `CrossAssetLevelsTable` (per-cell `T*`
provenance chip) · `ProvenanceChip` · `FreshnessBadge` (fresh / stale-as-of / unavailable→"—") · `ScorecardView` (public,
miss-inclusive) · `ConsensusRangeCard` (name-only, link-out). Visual: homepage grid = Daily Briefing card (top) → 3-up Mood/
Recession/Buzz dials → Consensus + alt-data row; every predictive element carries provenance + freshness + a standing "Not
financial advice." footer; stale data **dims** (SWR semantics surfaced). **"Explain → seed chat":** clicking pre-fills the finance
chat with the cached generation (no extra LLM spend); follow-ups fall through to the live tool loop; interactions fire
`POST /finance/events` → `CardEvent` (batched `sendBeacon`) → `behavioralBoost` in the ranking
`score = recencyDecay × magnitude × watchlistRelevance × behavioralBoost`.

---

## Part D — The four resolved blockers (B1–B3, S3) + should-fix items

### B1 — FK vs bare userId (RESOLVED)
Live schema uses `onDelete: Cascade` on every per-user relation (`GmailConnection`; the blueprint's `Watchlist`). Decision:
- **`Briefing.userId` → FK + `onDelete: Cascade`** (+ `briefings Briefing[]` back-relation on `User`). Per-user content; delete with the user.
- **`CardEvent.userId` → bare, `String?` nullable, NO FK** — *intentional and documented in a schema comment*: high-write append-only
  analytics, decoupled to avoid write contention and to retain anonymized events after a user is deleted (GDPR = anonymize the
  column, not delete the row). Nullable also lets logged-out card impressions be captured.

### B2 — The migration command on the pgvector-drift DB (RESOLVED)
The schema correctly has **no `extensions=[...]`** → the destructive-reset drift trap is structurally avoided. But `migrate dev`
needs a **shadow DB, and Supabase cannot be one.** Procedure:
1. `cd backend && bun --bun run prisma migrate dev --name market_insights_persistence --create-only` → **inspect the SQL**: confirm
   it only adds the 9 tables / 2 enums / indexes + the `Watchlist→User` and `Briefing→User` FKs, and **does NOT touch `cached_query`/the
   `vector(1536)` column.**
2. Apply via `migrate dev` against a **local Postgres that has pgvector** (`pgvector/pgvector:pg16`, or `postgres:16` + `CREATE
   EXTENSION vector`) **or** a separate Supabase shadow project (`SHADOW_DATABASE_URL`). The shadow MUST have pgvector so the baseline
   migration (which creates `cached_query.embedding vector(1536)`) replays without error.
3. **Production Supabase = `prisma migrate deploy`** in the Vercel build — **never `migrate dev`, never `migrate reset`** against Supabase.
4. **Escape hatch** if no pgvector-capable shadow is available: `prisma migrate diff --from-config-datasource --to-schema
   ./prisma/schema.prisma --script > delta.sql` → review → `prisma db execute --file delta.sql` → `prisma migrate resolve --applied <name>`.
5. `CachedQuery.embedding` stays `Unsupported("vector(1536)")`. After migrate: `prisma generate` + full dev-server restart.

### B3 — BigInt JSON serialization (RESOLVED)
`DailyOHLC.v` is `BigInt`; `JSON.stringify` throws on `bigint`. Two rules:
1. **Routes:** `Number()`-cast `v` before `res.json` (safe — volume < 2^53).
2. **Write path:** when building any `Json` field that may carry a volume-derived value (`HouseViewCall.inputsSnapshot`,
   `MarketMoodReading.components`, `evidence`), the snapshot-builder must `Number()`-cast BigInt-derived numbers **before**
   assembling the object passed to Prisma `create` — else the `create` throws at write time.

### S3 — Phase-1 Mood "all-green" contradiction (RESOLVED — the important one)
The 7-input Mood's momentum / breadth / realized-vol / 52wk-hi-lo legs derive from index & constituent **prices**, which in Phase 1
come from **Yahoo (RED, permanent)**. By the contamination rule, that Mood is **RED**, contradicting the "launch-safe, `commercialOk:true`"
claim. **Resolution (matches the existing finance-tab reality where Yahoo = `commercialOk:false`):**
- **Public v1 hero = a GREEN-only "macro-sentiment" Mood:** recession-probit / Treasury safe-haven + GDELT tone + CFTC positioning
  (+ self-computed realized-vol only if its price input is from a GREEN source). **Drop the equity momentum/breadth legs at public
  launch.** Label it "Lumina Market Mood — a macro-sentiment composite," `commercialOk:true`, public today.
- **The richer 7-signal equity-input Mood (and the index strips / sector treemap / VIX surfaces) ship `commercialOk:false`
  (demo-gated) and go public the moment the FMP commercial Data-Display license is signed** — Phase 2's "paid spine" (already
  earmarked as the Tier-2 commercial spine in the finance-tab work). Same conclusion for every Yahoo-priced surface.

### Should-fix (won't block the migration)
- **S1 — shared rate budgets across serverless instances:** "≤10 rps" for SEC and GDELT's throttle are **not** enforceable with
  per-instance counters on Vercel → use the existing Upstash shared rate budget (`backend/lib/ratelimit.ts`) + a distributed lock so
  the warmer and a concurrent cold read don't both fire. Name it explicitly for SEC (or risk an IP ban at Tier 2) and GDELT.
- **S2 — `<BRIEFING>` wire contract:** specify the exact `<BRIEFING>{…}</BRIEFING>` JSON payload (serialized `NumberFact[]`) so the
  backend tail and the lumina-frontend parser are written against ONE contract.
- **S4 — launch state is uniformly "descriptive only":** with `MIN_SAMPLE=8`, **zero dials are calibrated at launch** for 8 trading
  days→8 months; the homepage must not assume calibrated dials on day one.
- **O1/O2/O3 (polish):** `Briefing.forDate String` vs `@db.Date` elsewhere is intentional (string idempotency key) — note it;
  `CardEvent` batch-flush trigger unspecified; Congress-PDF parse-success target rate for Phase 3.

---

## Part E — Phasing

**Phase 1 — the launch-safe wedge (ship now, zero spend, zero contracts).** Treasury rates/curve + spreads · BLS→Sahm +
self-computed recession probit · GDELT Bull/Bear Buzz · CFTC COT · **Lumina Market Mood from GREEN inputs only** · the
tool-grounded **Daily Briefing** (shared card + seed-chat) · the **scorecard** substrate + emit/resolve crons · the **safety
layer**. All `commercialOk:true` by law. Files: `backend/finance/{briefing,briefing-tools,sentiment-sources,ingest}.ts`,
`backend/finance/{accuracy,guards}/*`, `schema.prisma` (+migration), `routes.ts`/`index.ts`/`prompt.ts`/`lib/wire.ts` edits,
`frontend/src/components/finance/*`. Gating: GDELT citation verbatim · BLS key (or v1 fallback) · consensus-range disclaimer wording.

**Phase 2 — the moat (calibrated history + paid spine).** The richer 7-signal Mood with an FMP commercial price spine (replaces
Yahoo) · HYG/LQD credit spread via a licensed feed (or GREEN bond-index substitute) · CoinGecko Basic crypto-breadth flip · the
scorecard passes `MIN_SAMPLE` so dials flip from "establishing" to calibrated · single-stock consensus · personalized watchlist
briefing (in-app first, email opt-in capped). Gating: Google verification for mass email (send-only to dodge CASA) · the paid
display license · recession coefficients fit offline + committed as constants.

**Phase 3 — alt-data / RAG.** Full signature alt-data belt (Congress PDF/OCR parser, Form 4 firehose, USAspending×LDA, ETF flow
proxy) · point-in-time S&P-500 constituents for survivorship-clean breadth · evolve the semantic answer-cache into a knowledge-RAG
that grounds briefing generation with cited chunks. Gating: PDF parse-failure UX · each ETF issuer's ToU · LDA cutover · a PIT
constituents source (license or accept permanent proxy).

---

## Source anchors
JPMorgan market-data-intelligence / dataquery / fusion pages; BlackRock BII weekly; Morgan Stanley Thoughts-on-the-Market; CNN
Fear&Greed (7-input) + supertype.ai methodology; Treasury daily yield XML; BLS LNS14000000 + Sahm rule; NY-Fed Estrella–Mishkin
probit; GDELT DOC 2.0 (about.html, doc-2-0 blog); CFTC COT (Socrata 6dca-aqww); SEC EDGAR APIs; House/Senate disclosure portals;
USAspending + Senate LDA; Vanna (NL→SQL) + LIDA (NL→chart) patterns; Feist / Barclays v. Theflyonthewall / Lowe v. SEC (consensus
legality); BofA Bull&Bear, Citi CESI/Panic-Euphoria, GS RAI (signature-indicator inspiration). Full per-claim sources in the
workflow transcripts (deep-research + the three market-insights workflows, 2026-06-23).
