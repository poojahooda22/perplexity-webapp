# Portfolio & Watchlist UX — from a hardcoded list to per-user state (and the cash-balance trap)

> The watchlist/portfolio surface of Lumina's Finance tab: where the symbols come from TODAY
> (hardcoded arrays — no user state at all), how to evolve it to a per-user DB watchlist without
> breaking the cache + budget contract, and the **contested-write reality** the moment a cash
> balance or paper-trade ledger is added (atomic guarded `UPDATE` + idempotency). `lumina-` ref =
> THIS codebase; verify every `file:line` against live code before relying on it (lines drift).
>
> **Read this when** the task touches the Watchlist, "add/remove a ticker", "let users save
> symbols", "portfolio / positions / paper trading", or any "track my money" feature. Adjacent refs:
> **screeners-and-scans.md** (the *list-at-scale* mechanics — server-side filter, pagination — that a
> big watchlist eventually needs), finance **finance-at-scale-rscale.md** (the R-SCALE battery for
> any finance list/search surface), finance **finance-frontend-and-ui.md** (the `FinanceView` shell
> these cards live in), finance **market-data-providers.md** (the credit math that caps watchlist
> size). This skill never fetches raw upstream — the DATA layer is **finance-markets**' job.

---

## 1. What exists today: a watchlist with zero user state

The "watchlist" is not a watchlist in the product sense — **nobody can add or remove a symbol.** It
is a fixed array of tickers the backend fetches for everyone, rendered in the right sidebar.

| Layer | Where | What's hardcoded |
|-------|-------|------------------|
| US watchlist symbols | `DEFAULT_WATCHLIST` (module-level const consumed by `fetchStocks`) in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts) (~line 387) | `["GOOGL","NVDA","TSLA","META","AAPL","AMZN"]` — 6 symbols, capped by the 8-credit/min Twelve Data budget. |
| India watchlist symbols | `INDIA_WATCHLIST` in the same file (~line 273) | 6 `.NS`/`.BO` symbols (Reliance, TCS, Infosys…), fetched via keyless Yahoo (TD free tier excludes NSE/BSE). |
| Render | `WatchlistAside` in [`frontend/src/components/finance/finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx) (~line 976) | `useStocks(useMarket())` → maps `data.items`; no add/remove UI, no input. |
| Company logos | `TICKER_DOMAIN` map in `finance-view.tsx` (~line 215) | `GOOGL→google.com`, etc. An unmapped ticker falls back to a 2-letter badge (`CompanyLogo`, ~line 234). |

Implications worth stating before you change anything:

- **There is no `userId` anywhere on this path.** `/finance/stocks` is mounted *before* auth (public
  read; see finance `lumina-finance-architecture.md`). The watchlist is the same for every visitor.
- **The symbol set is shared, so one cache key serves everyone.** `fetchStocks` is wrapped by
  `getOrRefresh("finance:stocks", 300, …)` (US) / `"finance:in:stocks"` (India). One Twelve Data hit
  per 5 min feeds all users — this is the whole reason the list is hardcoded and small.
- **"Live" ticks merge by symbol, not by user.** `use-live-prices` merges the worker's Finnhub ticks
  into the `["finance","stocks"]` TanStack cache (see finance `realtime-prices-websocket.md`); it
  keys on symbol, so a per-user list still works as long as the *union* of symbols is what the worker
  subscribes to.
- **There is no portfolio, no positions, no cash, no quantity.** Only quotes. Any "holdings" or
  "P&L" feature is net-new state, not an extension of this.

This is a **Tier-1** implementation (per the R-SCALE battery) and is *correct as a demo* — the failure
mode is shipping it while believing it scales to per-user lists or money.

---

## 2. The data-model evolution ladder

Three honest stages. Pick the lowest one that meets the requirement; do not skip to Stage 3 for a
portfolio demo, and do not pretend Stage 1 is Stage 2.

| Stage | Storage | Per-user? | Cache key | Budget reality | When |
|-------|---------|-----------|-----------|----------------|------|
| **0 — Hardcoded (today)** | Arrays in `sources.ts` | No | One shared key | Trivial: 1 batch / 5 min for everyone | Demo, fixed curated list |
| **1 — Client-local** | `localStorage` symbol list | Per-browser (not per-account) | Still one *fetch* key per symbol-set… but now the set varies → cache fragmentation | Each distinct list = its own batch; uncontrolled growth blows the 8/min cap | Quick "let me track my own" without a DB; survives until lists diverge |
| **2 — Per-user DB** | `Watchlist`/`WatchlistItem` Prisma rows | Yes (auth required) | Fetch is per *symbol*, not per list; UI list is a DB read | The **union of all users' symbols** is what hits the vendor — this is the scaling pressure | Real product: save across devices, server-rendered, shareable |

### Stage 2 sketch (Prisma, the natural next step)

```prisma
model WatchlistItem {
  id        String   @id @default(cuid())
  userId    String                       // FK to the auth user (Clerk/Supabase id)
  symbol    String                       // canonical, UPPERCASE, no exchange suffix
  market    String   @default("us")      // "us" | "in" — matches the Market type
  createdAt DateTime @default(now())
  @@unique([userId, symbol, market])     // idempotent add: dup insert is a no-op
  @@index([userId])                      // the list query is by user
}
```

The critical move for scale is **decoupling "what the user watches" (DB) from "fetch this quote"
(cache key per symbol):**

- The watchlist *list* is a cheap indexed DB read (`WHERE userId = ?`).
- Quotes are fetched/cached **per symbol** (`finance:quote:NVDA`), not per user-list — so two users
  both watching NVDA share one upstream hit. This is exactly the `fetchQuotes` agent path
  (`finance:quote:*`) generalized; reuse `getOrRefresh` + `withinBudget`, never invent a per-user
  fetch. The vendor pressure is then `|union of all watched symbols|`, not `|users|`.
- Cross-ref **screeners-and-scans.md** / finance `finance-at-scale-rscale.md`: at 100×/10 000× the
  union of symbols, the per-request live-fetch fan-out dies — you move to a server-side **snapshot
  table** (a cron warms quotes for the union into a row store; the watchlist read joins against it),
  pagination, and virtualization. State the tier you're shipping.

### Decision framework — which stage?

```
Need to persist a user's symbols?
 ├─ No (curated demo list)              → Stage 0 (today). Done.
 ├─ Yes, single device, no login        → Stage 1 (localStorage). Cap the list (e.g. 12) so the
 │                                          symbol-set can't blow the vendor budget.
 └─ Yes, across devices / per account    → Stage 2 (Prisma per-user). Requires auth on the route.
        └─ Many users, large symbol union → add a cron-warmed snapshot table + pagination
                                            (screeners-and-scans.md). This is a list-at-scale problem.
```

---

## 3. Add/remove: even a watchlist mutation needs idempotency

A watchlist edit looks innocent, but "user double-taps the star" is a real contested-write in
miniature. Two rules:

1. **Make add idempotent at the schema level.** The `@@unique([userId, symbol, market])` above turns
   a duplicate add into a no-op (`INSERT … ON CONFLICT DO NOTHING` / Prisma `upsert`). Never
   read-then-insert ("does it already exist? no → insert") — two concurrent taps both read "no" and
   you get a dup or a unique-constraint 500.
2. **Make remove idempotent.** `DELETE WHERE userId=? AND symbol=?` deleting 0 rows is success, not
   an error. Removing a symbol that's already gone must return 200.

These are the *gentle* version of §4. They matter because they teach the mechanism (the DB constraint
is the arbiter, not app-code logic) before any money is involved.

---

## 4. Portfolio / paper-trading (informational) — and the cash-balance trap

> **Lumina has no portfolio or cash today.** Everything here is the contract for *if it is added.*
> Per Non-Negotiable #1 (`trading-safety-and-disclaimers.md`), any positions/P&L surface is
> **informational only** — it displays what the user entered, never "buy/sell/hold" or allocation
> advice, and ends on "Not financial advice."

### 4a. Read-only portfolio (the safe version)

A portfolio that just stores positions the user typed in (`symbol`, `qty`, `costBasis`) and shows
current value/P&L is **not a contested write** — each position row is owned by one user, mutations are
single-owner, and "value" is `qty × live price` computed at render from the same cached quotes the
watchlist uses. This is a natural Stage-2 sibling: another per-user table, the same symbol-keyed quote
cache. Ship this freely; the only hazards are idempotent add/remove (§3) and not fabricating prices
(Non-Negotiable #2 — value must come from a real fetched quote).

### 4b. The moment you add a **shared cash balance** — STOP and treat it as fintech

A paper-trade cash balance (or any single mutable number multiple requests can change) is the **same
class of problem as a bank balance, a seat booking, or contested inventory** — cross-ref the global
R-SCALE rule §D and finance `finance-at-scale-rscale.md`. The failure is invisible in a demo (one
user, one tab) and a guaranteed incident under concurrency (double-tap "buy", a retried request).

**The one rule that prevents it: never read-then-write a balance in app code. Make the decrement a
single atomic guarded statement, and make the request idempotent.**

```sql
-- ❌ WRONG — read-then-write. Two concurrent "buy" requests both read 1000, both write 800;
--    the user spends 400 but only 200 is deducted. Classic lost update / oversell.
SELECT cash FROM paper_account WHERE user_id = $1;   -- app reads 1000
-- app computes 1000 - 200 = 800
UPDATE paper_account SET cash = 800 WHERE user_id = $1;

-- ✅ RIGHT — atomic guarded UPDATE. The row lock is the single ticket window; the WHERE clause
--    IS the funds check. If 0 rows are affected, the buy failed "insufficient funds" — no overspend.
UPDATE paper_account
   SET cash = cash - $amount
 WHERE user_id = $1 AND cash >= $amount;
-- rowsAffected === 0  → reject ("insufficient cash"); never went negative.
```

The four guarantees a cash/ledger mutation must satisfy (each maps to an R-SCALE §D question):

| Guarantee | Mechanism | R-SCALE §D |
|-----------|-----------|------------|
| **Atomicity** | One `UPDATE … SET cash = cash - ? WHERE … AND cash >= ?`; the DB row lock serializes concurrent writers. Never compute the new value in app code. | Q15 — atomic guarded decrement |
| **Idempotency** | Client sends an `idempotencyKey` per buy attempt; a unique trade-id row means a retried/double-tapped request can't decrement twice. | Q17 — retried request must not double-apply |
| **No negative state** | The `AND cash >= ?` guard; 0 rows affected = rejected, not overdrawn. | Q15 — request 51 fails the guard |
| **Source of truth = ledger** | Prefer balance = `SUM(ledger entries)` over a single mutable column; every trade is an append-only entry, balance is derived (or a cached column reconciled against the ledger). | Q20 — one number vs sum of rows |

Two-state placement (PLACED → FILLED) and a compensating action on failure (refund/restock the
position) come straight from R-SCALE §G — even for *paper* trades, model it the same way so the habit
is right. A retried fill that succeeded once must be a no-op (idempotent handler), not a second
deduction.

### Decision framework — does this feature need the atomic-write machinery?

```
Does the feature mutate a number that more than one request can change concurrently?
 ├─ No  (per-user list, per-user position rows, display-only value)  → §3 idempotency is enough.
 └─ Yes (cash balance, shared buying power, a counter, "units left")  → §4b in full:
        atomic guarded UPDATE + idempotency key + ledger-as-truth + two-state placement.
        This is fintech. Treat it like one. (R-SCALE §D + §G.)
```

---

## 5. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Calling the hardcoded `DEFAULT_WATCHLIST` a real "watchlist" feature. | It's a fixed curated list (Stage 0, no user state). Name the stage; build Stage 1/2 only when persistence is actually required. |
| Per-user watchlist that fetches each user's list as its own vendor batch. | Fetch/cache **per symbol** (`finance:quote:SYM`), read the user's *list* from the DB. Two users sharing NVDA share one upstream hit. |
| Letting a per-user watchlist grow unbounded against an 8-credit/min vendor cap. | Cap the list size; the binding constraint is the **union** of all users' symbols vs the budget (`market-data-providers.md`). Big lists → snapshot table (screeners ref). |
| Add-to-watchlist via "SELECT exists? → INSERT". | `@@unique([userId,symbol,market])` + upsert / `ON CONFLICT DO NOTHING`. The constraint is the arbiter; app-code existence checks race. |
| Remove that 404s when the symbol's already gone. | Idempotent delete: 0 rows deleted is success (200). |
| Fabricating a portfolio value / P&L the LLM "knows". | `qty × live price` from a **real fetched quote** through the cache; if the quote is `unavailable`/`stale`, say so (Non-Negotiable #2). |
| `SELECT cash → compute → UPDATE cash = $newValue` for a paper balance. | `UPDATE … SET cash = cash - ? WHERE user_id=? AND cash >= ?`; rowsAffected 0 = rejected. Never two-step a shared counter. |
| A retried/double-tapped "buy" decrements twice. | Idempotency key per attempt + unique trade row; the handler is a no-op on replay (R-SCALE §D Q17, §G Q23). |
| Storing balance as one mutable column and trusting it. | Append-only ledger; balance = `SUM(entries)` (or a column reconciled against it). Source of truth is the ledger (R-SCALE §F Q20). |
| Adding cash/positions but giving allocation/"you should buy" guidance. | Informational only: show numbers + neutral framing; end with "Not financial advice." (`trading-safety-and-disclaimers.md`). |

---

## 6. Where to add things (cheat sheet)

- **Change the curated watchlist symbols (Stage 0)** → edit `DEFAULT_WATCHLIST` / `INDIA_WATCHLIST`
  in [`backend/finance/sources.ts`](../../../../backend/finance/sources.ts); add the company's domain
  to `TICKER_DOMAIN` in [`finance-view.tsx`](../../../../frontend/src/components/finance/finance-view.tsx)
  so the logo resolves (else it falls back to a 2-letter badge). Keep the count ≤ 8 (TD credit cap).
- **Per-user watchlist (Stage 2)** → add the `WatchlistItem` model (§2); a *new authed* route (NOT on
  the public `/finance/*` prefix — those mount before auth); fetch quotes per-symbol via the existing
  `fetchQuotes`/`getOrRefresh`/`withinBudget` path; render in `WatchlistAside` with add/remove
  (idempotent, §3). Answer the finance R-SCALE list questions before calling it done.
- **Read-only portfolio** → a per-user `Position` table; value = `qty × cached live price`; reuse the
  symbol-keyed quote cache; idempotent add/remove; no advice. (§4a.)
- **Cash balance / paper trading** → do NOT ship without §4b: atomic guarded `UPDATE`, idempotency
  key, ledger-as-truth, two-state placement + compensation. This is the fintech surface; route any
  "is this safe under concurrency" question through R-SCALE §D/§G first.

---

## 7. Output contract (what "done" looks like)

A watchlist/portfolio change is done when:
1. **Stage named:** you stated which stage (0/1/2) you shipped and what breaks at the next tier
   (R-SCALE), instead of implying a hardcoded list is a per-user feature.
2. **Cache contract intact:** quotes fetched/cached **per symbol** through `getOrRefresh` +
   `withinBudget`; per-user state is a DB read, never a per-user vendor batch; list size bounded
   against the vendor cap.
3. **Mutations idempotent:** add via a unique constraint + upsert; delete tolerant of 0 rows.
4. **No fabricated numbers:** any value/P&L computed from a real fetched quote; `stale`/`unavailable`
   surfaced honestly.
5. **If money/contested state exists:** atomic guarded `UPDATE` + idempotency key + ledger-as-truth +
   two-state placement — you can name each guarantee and its R-SCALE §D/§G question.
6. **Safe:** informational only; no buy/sell/hold or allocation advice; "Not financial advice."
   present on any portfolio prose.
7. **Verified:** the list renders the expected symbols/quotes; new backend files → full dev-server
   restart (Bun `--hot` misses them); relative imports carry explicit `.js`.
