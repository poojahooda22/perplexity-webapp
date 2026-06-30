# Theory — Pagination: Cursor/Keyset vs Offset (the contract for every delivery channel)

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (DataQuery/Fusion re-engineering, "Project 3") — **NOT Lumina**. This is a generic, reusable theory doc for the Python/FastAPI data-plane that serves time-series and catalogue data over REST/SDK channels. No Lumina (Bun/Express/Prisma/Upstash) wiring here.
>
> **Why this doc is small and load-bearing.** Pagination is the one decision on a delivery channel where the *demo passes and production dies*. A time-series endpoint paged with `OFFSET` works perfectly on 10k rows and falls over at 10M — and you find out on a sale-day-equivalent (a backfill, a bulk export, a wide universe pull), not in code review. The R-SCALE rule (`~/.claude/rules/product-scale-architecture.md` §A, §C) names this exact surface: **lists and search are scale surfaces; getting their paging wrong is a Tier-3 break that is invisible at Tier 1.** This doc fixes the decision once so every channel inherits the right answer.

---

## 0. The one-paragraph answer (read this if nothing else)

**Default to cursor/keyset pagination for every series and every large or growing collection.** Use a `WHERE (sort_key) < (last_seen_sort_key)` filter over a **stable, indexed sort key**, return an **opaque `next_cursor`** that encodes that key plus a `has_more` flag, and document a **max + default page size**. Offset/`LIMIT … OFFSET` is acceptable **only** for small, bounded, rarely-changing result sets — catalogue/discovery browse pages where the total is in the hundreds and a user genuinely jumps to "page 7". JPMorgan's own DataQuery does exactly this split: its **catalogue/discovery** endpoints take `limit`/`offset`/`page`, while its **time-series download** uses a `links[].next` continuation cursor ([jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk); [macrosynergy DataQuery client](https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html)). The cost of getting this wrong is **linear degradation** (`O(n)` in offset depth) plus **silent skip/duplicate under concurrent writes** — both fatal for a financial-data platform whose whole value is correctness at scale.

---

## 1. Why offset pagination is a time bomb

### 1.1 The mechanism — the DB fetches and *discards* everything you skip

Offset pagination is the SQL `LIMIT … OFFSET` (or `OFFSET … FETCH`) construct:

```sql
SELECT * FROM transactions
ORDER BY created_at DESC
LIMIT 20 OFFSET 40;
```
([dev.to — A Developer's Guide to API Pagination](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h))

The fatal property: **`OFFSET` does not let the database skip rows cheaply — it must produce them and throw them away.** The SQL:2023 standard, quoted by use-the-index-luke, defines it precisely: rows are *"first sorted according to the `<order by clause>` and then limited by dropping the number of rows specified in the `<result offset clause>` from the beginning"* ([use-the-index-luke.com/no-offset](https://use-the-index-luke.com/no-offset)). "Dropping from the beginning" means the engine walked them first.

Markus Winand's core indictment: *"the database must still fetch these rows from the disk and bring them in order before it can send the following ones."* And the reason it can't optimize this away: *"OFFSET accepts only one parameter — the count of rows to skip — providing no context to optimize this operation"* ([use-the-index-luke.com/no-offset](https://use-the-index-luke.com/no-offset)). The query has no idea *which* rows you already saw; it only knows *how many* to burn.

Step-by-step, to satisfy a deep offset query like `LIMIT 10 OFFSET 100000` the engine must:

1. fetch at least **offset + limit = 100,010 rows**,
2. sort them (if the index doesn't already provide the order),
3. load that result set (or a large chunk) into memory,
4. **drop the first 100,000 rows**,
5. return the remaining 10.

([engineeringatscale — API Pagination](https://engineeringatscale.substack.com/p/api-pagination-limit-offset-vs-cursor): *"fetch at least 100,010 rows (offset + limit), sort them … load that result set … into memory, drop the first 100,000 rows, and return the remaining 10."*)

### 1.2 The cost is *linear in the offset* — `O(n)`, not `O(1)`

> *"The cost of a query grows linearly with the offset value."* — ([Gusto Embedded blog, via search](https://embedded.gusto.com/blog/api-pagination/))

Concretely, the same dataset, different depths:

> *"Fetching page 1 can take 10 milliseconds, while page 1000 can take several seconds on the same data set."* — ([dev.to guide](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h))

> *"The first 50 pages are fast, page 500 is slow, and page 5,000 is unusable."* — ([engineeringatscale](https://engineeringatscale.substack.com/p/api-pagination-limit-offset-vs-cursor))

Complexity, stated formally:

> *"Limit-offset pagination has O(N) complexity in the offset: as N grows, latency and memory use grow until the database runs out of resources or times out. In contrast, cursor-based pagination has a fetch cost that is effectively O(1) in the depth of the list."* — ([engineeringatscale](https://engineeringatscale.substack.com/p/api-pagination-limit-offset-vs-cursor))

**Worked arithmetic for our product line.** A time-series endpoint over a market-data hypertable. One symbol, daily bars, 30 years ≈ 7,800 rows — offset is fine there. But the killers on a data platform are the *wide* pulls:

- **Bulk export / backfill** of a 5,000-symbol universe at 1-minute bars over a year ≈ 5,000 × ~98,000 ≈ **490M rows**. A client paging this at 1,000 rows/page with offset issues page #100,000 as `OFFSET 100000000`. The DB walks 100M rows to hand back 1,000. The *last* pages of a full export each cost ~half a table scan. Total work to export N rows by offset ≈ **N²/(2·pagesize)** row-touches — quadratic in the table size. At 490M rows / 1k page that's ~1.2 × 10¹⁴ row-touches. The export never finishes.
- The same export by **cursor**: each page is one index range-scan that stops at LIMIT — **N/pagesize pages, each O(log N + pagesize)**. Total work ≈ **N · log N**. Linearithmic vs quadratic. This is the difference between "the nightly export completes in minutes" and "the nightly export is an incident."

### 1.3 The *correctness* bug: skip & duplicate under concurrent writes

Performance is the famous problem; **the silent one is worse.** Offset addresses rows *by position in a snapshot that is re-taken on every request.* Any insert or delete *before* your current position shifts every later row, so offset paging over a *live* table **skips rows or returns duplicates** — and the client never knows.

Markus Winand: the keyset/seek method exists precisely because with offset *"pages drift when inserting new sales"* ([use-the-index-luke.com — fetch-next-page](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)). His blunt verdict: *"The idea to use the number of rows seen to skip over them later is simply wrong"* (unless the data is frozen) ([use-the-index-luke.com/no-offset](https://use-the-index-luke.com/no-offset)).

A worked example from the guides:

> *"Say a user is on page 5 of transaction records. While they're browsing, three new transactions are added at the top. When they click **Next**, the offset advances, but so does the data. Now they either see duplicate records or skip some entirely."* — ([dev.to guide](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h))

The mechanism, drawn out:

```
Snapshot at request for page 1 (newest-first, OFFSET 0 LIMIT 10):
   rows:  R10 R9 R8 R7 R6 R5 R4 R3 R2 R1      ← client receives R10..R1

   ... 3 new rows R11 R12 R13 inserted at the top ...

Snapshot at request for page 2 (OFFSET 10 LIMIT 10):
   rows:  R13 R12 R11 R10 R9 R8 R7 R6 R5 R4 R3 R2 R1
          └──────── skipped by OFFSET 10 ────────┘ R3 R2 R1 ...
   client receives R3 R2 R1 + older   ← R10..R4 were ALREADY SHOWN; now SKIPPED?
```

Depending on insert/delete direction you get **duplicates** (rows re-appear on the next page) or **holes** (rows seen by nobody). On a financial-data platform this is not cosmetic: a sync loop that misses a row misses a **trade, a corporate action, a price**. The provider-side reconciliation never balances.

Getknit states the consistency property cleanly:

> *"if records are inserted or deleted between page requests, offset pagination skips or duplicates records; cursors point to a specific position so page boundaries remain consistent."* — ([getknit.dev](https://www.getknit.dev/blog/api-pagination-techniques))

> *"cursor-based pagination is more reliable for integration sync loops because it handles insertions and deletions between pages gracefully."* — ([getknit.dev](https://www.getknit.dev/blog/api-pagination-techniques))

**This is the decisive reason for a data platform.** Even if offset's latency were free, its *non-determinism under writes* alone disqualifies it for any live series. Our ingest is continuous (market data streams in; backfills land; corrections arrive). A page boundary that depends on "how many rows exist right now" is a boundary that moves under the reader's feet.

### 1.4 What offset *cannot* do that you might miss

- **No stable "resume."** A client that stored "I got to page 412" cannot reliably resume tomorrow — page 412 is a different window once rows changed.
- **`total_count` is a second full cost.** Offset UIs usually want "page 7 of 240", which needs a `COUNT(*)` over the (possibly filtered) set — a second scan, often as expensive as the page itself. (More in §5.3.)

---

## 2. Why cursor/keyset is the time-series default

### 2.1 The mechanism — a `WHERE` filter on the last seen key, not a row count

Keyset (a.k.a. "seek method", a.k.a. the engine under "cursor pagination") replaces *"skip N rows"* with *"give me rows that sort after the last one I saw."* It exploits the ORDER BY's *"definite sort order"* and uses *"a simple filter to only select what follows the entry we have seen last"* ([use-the-index-luke.com/no-offset](https://use-the-index-luke.com/no-offset)):

```sql
SELECT *
  FROM transactions
 WHERE (created_at, id) < ('2025-10-15 10:00:00', 12345)
 ORDER BY created_at DESC, id DESC
 LIMIT 20;
```
([dev.to guide](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h))

The win is structural: instead of an `O(N)` linear scan-and-discard the database does an **indexed seek** straight to the boundary and reads forward exactly `LIMIT` rows:

> *"The database directly navigates to the cursor instead of reading the first N records."* — ([engineeringatscale](https://engineeringatscale.substack.com/p/api-pagination-limit-offset-vs-cursor))

> *"The database leverages its B-Tree index to efficiently locate this specific record and retrieve subsequent items, transforming the lookup from an O(N) linear scan to an O(log N) indexed lookup, providing consistent, fast performance regardless of how deep into the dataset the user navigates."* — ([engineeringatscale, via search](https://engineeringatscale.substack.com/p/api-pagination-limit-offset-vs-cursor))

So each hop is **`O(log N)` to find the boundary + `O(pagesize)` to read forward** — *independent of how deep you are*:

> *"Latency stays flat whether the user is on 'page' 1 or 'page' 1,000,000 with cursor-based pagination."* — ([engineeringatscale, via search](https://engineeringatscale.substack.com/p/api-pagination-limit-offset-vs-cursor))

### 2.2 It is consistent under concurrent writes — the property that matters most

Because the boundary is a **value, not a position**, inserts and deletes elsewhere don't move it. Winand: the seek method *"enables the database to truly skip the rows from the previous pages"* using index access, yielding *"stable results if new rows are inserted"* and avoiding the OFFSET pathology where *"pages drift when inserting new sales"* ([use-the-index-luke.com — fetch-next-page](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)).

Speakeasy frames the same property at the API level: a cursor is a *"stable marker identifying a specific record in the dataset"* rather than a positional reference, *"preventing duplicate records when data changes between requests"* ([speakeasy.com/api-design/pagination](https://www.speakeasy.com/api-design/pagination)).

For a series that is being **appended to continuously** (every market tick, every corrected bar), this is exactly right: a reader walking history backward from "now" sees a coherent slice even as new rows arrive at the head.

### 2.3 The honest trade-offs (cursor is not free)

| Property | Offset | Cursor / keyset |
|---|---|---|
| Deep-page latency | `O(n)` — degrades, eventually unusable | `O(log N)` — flat ([engineeringatscale](https://engineeringatscale.substack.com/p/api-pagination-limit-offset-vs-cursor)) |
| Consistency under writes | skips / duplicates ([getknit](https://www.getknit.dev/blog/api-pagination-techniques)) | stable boundaries ([use-the-index-luke](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)) |
| Jump to arbitrary page N | yes (`OFFSET N·pagesize`) | **no** — sequential only ([use-the-index-luke/no-offset](https://use-the-index-luke.com/no-offset): keyset *"cannot directly navigate to arbitrary page numbers"*) |
| `total_count` cheap | no (needs `COUNT(*)`) but expected by the UI | also needs `COUNT(*)`; usually omitted (§5.3) |
| Backward paging | trivial (decrement offset) | needs a reversed query + prev cursor |
| Index requirement | none mandatory | **mandatory**: index must match the sort key (§4) |
| Best fit | small, bounded, stable browse sets | series, large/growing collections, sync loops |

Getknit's summary: cursor is *"stable and performant even on large or frequently-updated datasets"* but *"doesn't support random page access or total record counts as easily"* ([getknit.dev](https://www.getknit.dev/blog/api-pagination-techniques)).

**The product implication:** time-series and bulk/export channels do **not** need "jump to page 412" — they need *streaming the whole slice consistently and fast*. They lose nothing they wanted by going cursor-only. The catalogue browse UI *does* want page numbers — and is small enough that offset's degradation never bites. That asymmetry is the whole §3 decision.

---

## 3. The decision: which channel gets which

> **Restate of the rule:** *Cursor/keyset for series and large/growing collections; offset only for small bounded discovery sets.* This is not a style preference — it's the line between Tier-3-safe and Tier-3-break per R-SCALE §A.

| Channel / endpoint class | Pagination | Why |
|---|---|---|
| **Time-series read** (`/timeseries`, OHLC, ticks, rollups) | **Cursor (keyset)** | Large, append-only, read deep into history; consistency under live ingest is mandatory. JPM DataQuery's own `time-series` endpoint uses `links[].next` continuation (§6). |
| **Bulk export / backfill** | **Cursor (keyset)**, streamed | N²-quadratic under offset (§1.2). Must complete; must be resumable from a stored cursor. |
| **Sync loop / incremental delta** (client mirrors our data) | **Cursor (keyset)**, often time-watermark cursor | Inserts/deletes between pages must not skip/dupe ([getknit](https://www.getknit.dev/blog/api-pagination-techniques): *"more reliable for integration sync loops"*). |
| **Search results** (instruments matching a query, ranked) | **Cursor** if the result set is unbounded/large; offset OK if capped (e.g. top-200) | Ranked search is a list scale-surface (R-SCALE §B); deep result sets degrade under offset. |
| **Catalogue / discovery browse** (groups, instruments in a group, available filters) | **Offset / page** acceptable | Bounded (hundreds–low thousands), rarely changing, user wants page numbers / "page 7". This is exactly where the guides say offset is fine. |
| **Admin / internal tables** (small, dev-facing) | **Offset** fine | Speed-of-development > scale; *"Small datasets, admin panels"* ([restguide.info](https://restguide.info/pagination)). |

This matches the published "when to use each":

- Cursor: *"best for real-time feeds and large datasets"* ([getknit](https://www.getknit.dev/blog/api-pagination-techniques)); *"Production applications … handling financial data, payroll, or real-time streams … when data sets grow continuously, data consistency is critical"* ([dev.to guide](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h)).
- Offset: *"Small data sets, prototypes, internal tools, or admin dashboards … when data rarely changes and users need traditional page numbers or bookmarking"* ([dev.to guide](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h)); *"Small datasets, admin panels", "Admin Dashboards"* ([restguide.info](https://restguide.info/pagination)).
- The rule of thumb: *"offset works fine for small, rarely changing data sets, but when the stakes and data volume are high, cursor is the better choice."* ([dev.to guide](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h))

**Gusto Embedded ships this exact split in production** — proof it isn't a purist's ideal but the operational norm:

> *"Gusto Embedded uses offset pagination when data is stable and cursors when data changes frequently — showing how production APIs can stay both developer-friendly and performant."* — ([Gusto Embedded blog, via search](https://embedded.gusto.com/blog/api-pagination/))

Their concrete endpoints, verbatim ([dev.to guide](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h)):

```
# Offset (stable, bounded employee list):
GET https://api.gusto.com/v1/companies/abc123/employees?page=2&per=5
   X-Page: 2
   X-Total-Count: 47
   X-Total-Pages: 10
   X-Per-Page: 5

# Cursor (high-volume, append-only event stream):
GET https://api.gusto.com/v1/events?starting_after_uuid=10ac74e7-...&limit=5
   X-Has-Next-Page: true
```

> **Decision in one line:** *Is this a series, a sync loop, or a set that grows without bound? → cursor. Is it a small fixed browse list a human pages through? → offset is fine.* When unsure, **default cursor** — it's the safe error; a wrongly-offset series is a latent incident, a wrongly-cursored catalogue is merely a slightly-less-convenient browse.

---

## 4. The stable-sort requirement (the rule that makes keyset correct)

Keyset only works if the sort order is **total and stable**, and the index **matches** it. Two non-negotiables:

### 4.1 The sort key must be unique (append a tiebreaker)

A keyset boundary is a value. If two rows share that value, the `<` filter can't tell them apart and you'll skip or duplicate at the boundary. **You must sort on a key that is unique** — for a series that means appending the row's unique id to the time column:

- Sort `(created_at)` alone → ties on the same timestamp (common at 1-minute bars across re-ingests, or to-the-second event streams). Boundary is ambiguous.
- Sort `(created_at, id)` → total order. `id` is the tiebreaker.

This is why every correct example pairs time with id: `(created_at, id)` ([dev.to](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h)), `(sale_date, sale_id)` ([use-the-index-luke](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)). R-SCALE §A makes it a rule: *"sort on indexed (time,id)."*

### 4.2 The index must cover the exact sort tuple, in order

> *"CREATE INDEX sl_dtid ON sales (sale_date, sale_id)"* — the index must match the `ORDER BY` clause structure. — ([use-the-index-luke.com/sql/partial-results/fetch-next-page](https://use-the-index-luke.com/sql/partial-results/fetch-next-page))

If the index columns or their order don't match the sort, the engine can't do the indexed seek and you've quietly fallen back to a scan + sort — keyset's whole advantage gone, and you won't notice until the explain plan shows a Sort node. For our TimescaleDB store the natural index is `(symbol, ts DESC, id)` (or the hypertable's time dimension + id); the per-symbol series seek rides it directly. (Index/store specifics live in the `timescaledb-timeseries` skill; the *contract* — "the sort tuple must be indexed" — lives here.)

### 4.3 Composite cursors: use **row-value (tuple) comparison**, not naive AND/OR

This is the single most common keyset bug. When the sort key has two+ columns, the boundary condition is **lexicographic**, and you must express it as a row-value comparison:

```sql
-- CORRECT: one row-value comparison, one index range
SELECT *
  FROM sales
 WHERE (sale_date, sale_id) < (?, ?)
 ORDER BY sale_date DESC, sale_id DESC
 FETCH FIRST 10 ROWS ONLY
```
([use-the-index-luke.com/sql/partial-results/fetch-next-page](https://use-the-index-luke.com/sql/partial-results/fetch-next-page))

Winand: row-value syntax *"combines multiple values into a logical unit that is applicable to the regular comparison operators."*

**The naive trap.** People reach for `WHERE sale_date < ?` (just the time):

> *"using the last date from the first page skips all results from yesterday — not just the ones already shown on the first page."* — ([use-the-index-luke.com/sql/partial-results/fetch-next-page](https://use-the-index-luke.com/sql/partial-results/fetch-next-page))

So you must include the tiebreaker, and the correct logic is *"the database considers only the sales that come after the given `SALE_DATE`, `SALE_ID` pair"* — which is exactly what `(sale_date, sale_id) < (?, ?)` expresses.

**The portability footnote (matters for our stack choice).** Not every engine plans the tuple form well, and the hand-rolled OR-expansion is a *correctness-equivalent but performance-disaster* alternative:

- The OR-expansion `(a < ?) OR (a = ? AND b < ?)` is logically identical but, on Postgres, *"cannot use the composite index … it scans matching rows linearly. Row-value comparison is a single index range, so it stops at LIMIT."* The OR form *"turns what should be a sub-millisecond Index Cond into a filter scan over millions of rows"* ([spring-data-jpa #4250, via search](https://github.com/spring-projects/spring-data-jpa/issues/4250)).
- Postgres *could* in theory plan the OR form via BitmapOr but *"does not in this case on tested versions 13–17 because per-branch selectivity estimates remain too high"* ([spring-data-jpa #4250, via search](https://github.com/spring-projects/spring-data-jpa/issues/4250)).
- Dialect support: *"on dialects where `supportsRowValueConstructorGtLtSyntax()` returns true (Postgres/MySQL/H2/CockroachDB/MariaDB), the translator emits the tuple verbatim; on dialects where it returns false, the comparison is emulated"* (the OR rewrite) ([spring-data-jpa #4250, via search](https://github.com/spring-projects/spring-data-jpa/issues/4250)).

**Our verdict:** we run **Postgres/TimescaleDB**, which *supports row-value comparison and plans it as a single index range*. So **emit the tuple form `(ts, id) < (?, ?)` verbatim** and never hand-roll the OR expansion. (Confirm the plan with `EXPLAIN` once: you want `Index Cond`, not a `Filter` over a scan.) The mixed-direction case — e.g. `ORDER BY ts DESC, id ASC` — is the one place tuple comparison *can't* express the boundary directly; avoid it by keeping all sort columns the same direction, which is natural for a "newest-first" series.

---

## 5. The response envelope (the channel contract every endpoint shares)

A delivery channel is only as good as its envelope. Standardize **one** shape across all channels so generated SDKs and clients learn it once.

### 5.1 The cursor envelope (the default)

```jsonc
{
  "data": [ /* ...page of rows... */ ],
  "pagination": {
    "next_cursor": "eyJ0cyI6IjIwMjYtMDYtMjRUMTA6MDA6MDBaIiwiaWQiOjEyMzQ1fQ",
    "has_more": true
    // "total_count": <omitted unless cheap — see §5.3>
  }
}
```

Field-by-field, with the published precedent for each:

| Field | Type | Meaning | Source precedent |
|---|---|---|---|
| `data` | array | the page of rows | ubiquitous; ([speakeasy](https://www.speakeasy.com/api-design/pagination)) |
| `next_cursor` | string \| null | **opaque** token to fetch the next page; `null`/absent ⇒ no more | ([speakeasy](https://www.speakeasy.com/api-design/pagination): `"next_cursor": "xyz789"`); ([restguide.info](https://restguide.info/pagination)) |
| `has_more` | boolean | is there another page? lets clients loop without inspecting cursor nullity | ([restguide.info](https://restguide.info/pagination): `"has_more": true`); Stripe `has_more` |
| `prev_cursor` | string \| null | *(optional)* token to page backward | ([dev.to](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h): `"prev_cursor"`); ([restguide.info](https://restguide.info/pagination): `"cursors": {"next", "prev"}`) |
| `total_count` | integer | *(optional)* total rows in the full set — **only when cheap** (§5.3) | ([speakeasy](https://www.speakeasy.com/api-design/pagination)) |

**Why both `next_cursor` and `has_more`?** They answer different questions. `has_more` is the loop condition (`while has_more: fetch(next_cursor)`); `next_cursor` is the loop variable. A client can drive the loop on `has_more` alone and never parse the cursor — which is the point of opacity (§5.4). Keeping both removes the ambiguity of "is `next_cursor: null` the end, or an error?".

### 5.2 The offset envelope (catalogue/discovery only)

```jsonc
{
  "data": [ /* ...page... */ ],
  "pagination": {
    "offset": 40,
    "limit": 20,
    "total": 150        // affordable here: the set is small & bounded
  }
}
```
([restguide.info](https://restguide.info/pagination): `"offset", "limit", "total"`; [dev.to](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h): `"limit", "offset", "total"`.)

Offset endpoints *can* afford `total` because the set is small — that's the same property that made offset acceptable in the first place.

### 5.3 `total_count` — provide it **only when it's cheap**

The rule (R-SCALE-aligned): **a `total_count` over a large, filtered, live set is a second full scan — don't ship it by default.** Cursor pagination *"avoids the need to count records to perform any sort of maths"* ([speakeasy](https://www.speakeasy.com/api-design/pagination)) — that's a *feature*, not a gap. Guidance:

- **Catalogue/discovery (offset):** the set is bounded → include `total`. Clients want "page 7 of 12".
- **Series / large collections (cursor):** **omit `total_count`.** The client doesn't need it (it streams until `has_more: false`), and computing it costs a scan. If a UI insists on an approximate count, serve `EXPLAIN`-derived row estimates or a cached/periodic count — never a live `COUNT(*)` on the hot path.
- Document the omission explicitly so SDK generators don't synthesize a field that isn't there.

### 5.4 The cursor must be **opaque**

The `next_cursor` is an **opaque string the client must echo back verbatim and never construct or parse.** This is doctrine across the sources:

> *"Obfuscating the information like this aims to stop API consumers hard-coding values."* — ([speakeasy](https://www.speakeasy.com/api-design/pagination)), illustrating a base64 cursor `dXNlcjpXMDdRQ1JQQTQ=` for `user:W07QCRPA4`.

> cursors are *"typically Base64-encoded to obscure internal implementation details and prevent clients from manually constructing invalid cursors."* — ([dev.to guide](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h))

Why opacity is load-bearing for *us*: it lets us **change the keyset internally** (add a tiebreaker column, switch the sort) without breaking any client — the cursor is our private encoding of the boundary, not a public contract. A client that reverse-engineered `{"id": 12345}` and started fabricating cursors would break the day we add `(ts, id, seq)`.

### 5.5 Documented max + default page size (mandatory)

Every paginated endpoint **must** document a default and a hard maximum `limit`:

> *"Set Reasonable Defaults: ✅ Good `limit=20` (default), `max_limit=100`."* — ([restguide.info](https://restguide.info/pagination)); *"Avoid allowing excessively large limits like 10,000."*

Recommended for this product line:

| Channel | default `limit` | max `limit` | Rationale |
|---|---|---|---|
| Time-series read (rows) | 1,000 | 10,000 | bars are small; chart/export wants chunky pages. (Chart *downsampling* — never return more points than the chart can draw — is a separate contract; see the `timescaledb-timeseries` skill.) |
| Bulk export | 10,000 | 50,000 | throughput over latency; still bounded so one page fits memory. |
| Catalogue / search | 20 | 100 | human browse; the published default. |

Enforce the max **server-side** by clamping (`limit = min(requested, MAX)`) — never trust the client. An unbounded `limit` is a denial-of-service vector (one request fetches the universe) and re-introduces the memory blowup pagination exists to prevent.

### 5.6 The `links[].next` continuation variant (DataQuery-native)

A second, equally valid envelope returns the *fully-formed next URL* instead of a bare cursor — the hypermedia/"links" style. Speakeasy shows it:

```jsonc
{
  "links": {
    "self": "/items?cursor=abc123&limit=10",
    "next": "/items?cursor=xyz789&limit=10"
  }
}
```
([speakeasy](https://www.speakeasy.com/api-design/pagination))

**This is exactly JPMorgan DataQuery's wire format** — see §6. The client follows `links.next` verbatim, just as it would echo a `next_cursor`. The two are isomorphic (a URL *is* an opaque continuation token that happens to also carry the path); pick one and be consistent. We adopt **`next_cursor` for our own JSON channels** (cleaner for SDK codegen) and **understand the `links[].next` form because the incumbent we re-engineer speaks it** — any client migrating off DataQuery already knows it.

---

## 6. Worked study: JPMorgan DataQuery's own pagination (the incumbent we re-engineer)

We are re-building DataQuery/Fusion; its pagination is primary-source evidence of the right split. Two officially-published clients confirm it.

### 6.1 Time-series download → `links[].next` cursor continuation

The Macrosynergy DataQuery client (a maintained, open client for JPM's DataQuery API) paginates the time-series download by following `response["links"][1]["next"]`, recursively, until it's `None`. Verbatim from its source:

```python
# macrosynergy/download/dataquery.py — the _fetch() pagination tail
if "links" in response.keys() and response["links"][1]["next"] is not None:
    logger.debug("DQ response paginated - get next response page")
    downloaded_data.extend(
        self._fetch(
            url=self.base_url + response["links"][1]["next"],
            params={},
            tracking_id=tracking_id,
        )
    )
```
([macrosynergy DataQuery client source](https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html))

And its endpoint constants ([same source](https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html)):

```python
CERT_BASE_URL:  str = "https://platform.jpmorgan.com/research/dataquery/api/v2"
OAUTH_BASE_URL: str = "https://api-developer.jpmorgan.com/research/dataquery-authe/api/v2"
TIMESERIES_ENDPOINT: str = "/expressions/time-series"
CATALOGUE_ENDPOINT:  str = "/group/instruments"
```

Read the mechanics:

- The next page is identified by an **opaque server-provided URL** (`links[1].next`), *not* an offset the client computes — pure cursor/continuation semantics.
- `params={}` on the follow-up call: all paging state is already baked into the `next` URL. The client carries **nothing** but the token. This is §5.4 opacity in the wild — the client never constructs the boundary.
- Termination is `next is None` — the server's equivalent of `has_more: false`.
- Results are **concatenated** (`list.extend`) across pages into one logical series — exactly how a streaming time-series read should compose.

**The lesson we copy:** for our `/timeseries` channel, the boundary is server-owned and opaque; the client loops "follow next until null." Whether we hand back `links.next` (DataQuery-compatible) or `next_cursor` (our default) is a surface choice over the *same* cursor mechanism.

### 6.2 Catalogue / discovery → `limit` / `offset` / `page`

JPM's own [jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk) exposes the *catalogue/discovery* surface with classic offset/page parameters ([README, via fetch](https://github.com/jpmorganchase/dataquery-sdk)):

- `search_groups_async(keywords, limit, offset)` — keyword search with **`limit` and `offset`**.
- `list_groups_async(limit)` — list groups with a **`limit`**.
- `list_instruments_async(group_id, instrument_id=None, page=None)` — **`page`**.
- `search_instruments_async(group_id, keywords, page=None)` — **`page`**.
- `get_group_filters_async(group_id, page=None)` — **`page`**.

**This is the §3 split, shipped by the incumbent itself:** the *bounded discovery surface* (groups, instruments-in-a-group, filters) is offset/page; the *unbounded series surface* (time-series download) is the `links[].next` cursor. Exactly the rule this doc prescribes — confirmed by the system we're re-engineering, not invented.

(Aside: the SDK also enforces a global rate budget — `DATAQUERY_REQUESTS_PER_MINUTE` default 300, `DATAQUERY_BURST_CAPACITY` default 5 ([README](https://github.com/jpmorganchase/dataquery-sdk)). Pagination and rate-limiting are siblings: deep paging multiplies request count, so the page size and the rate budget must be designed together — a small page size over a huge set can blow the rate budget before the cursor reaches the end. Budget the *number of pages*, not just the *rows per page*.)

---

## 7. How generated SDKs expose pagination (the auto-iterate contract)

A delivery channel ships an SDK (generated from our OpenAPI spec). The pagination envelope must be **codegen-friendly** so the SDK can offer the two idioms clients expect.

### 7.1 The two idioms

> *"SDKs iterate through paginated API results using two primary methods: an automatic iterator, like a for...of loop, which fetches new pages for you behind the scenes, and a manual page-by-page approach that gives you explicit control over each request."* — ([Stainless — Iterate Paginated Results](https://www.stainless.com/sdk-api-best-practices/how-to-iterate-paginated-results-in-sdks-examples))

> *"The most ergonomic approach is the auto-paginating iterator, which lets you use a standard for loop … and the SDK handles fetching subsequent pages automatically in the background as you iterate, allowing you to process an entire dataset without ever thinking about pages, cursors, or tokens."* — ([Stainless](https://www.stainless.com/sdk-api-best-practices/how-to-iterate-paginated-results-in-sdks-examples))

### 7.2 What "auto-iterate" looks like (Stripe, the canonical reference)

Stripe's libraries auto-paginate from exactly the `has_more` + cursor (`starting_after`) shape we standardized in §5:

> *"To use the auto-pagination feature in Python, simply issue an initial 'list' call with the parameters you need, then call `auto_paging_iter()` on the returned list object to iterate over all objects matching your initial parameters."* — ([Stripe — Auto-pagination](https://docs.stripe.com/api/pagination/auto))

Per-language method names, verbatim ([Stripe — Auto-pagination](https://docs.stripe.com/api/pagination/auto)):

| Language | Auto-paginate call |
|---|---|
| Python | `auto_paging_iter()` on the list object |
| Ruby | `auto_paging_each` |
| PHP | `autoPagingIterator()` |
| Java | `autoPagingIterable()` |
| Node 10+ | iterate the list call in a `for await` loop |
| Older Node | `autoPagingEach(onItem)` |
| .NET | `ListAutoPaging` |

Illustrative client usage against *our* channel (shape mirrors Stripe/Stainless idioms):

```python
# Auto-iterate: the SDK follows next_cursor under the hood; client never sees a cursor.
for bar in client.timeseries.list(symbol="AAPL", interval="1m", limit=1000).auto_paging_iter():
    process(bar)        # transparently spans thousands of pages

# Manual page-by-page: explicit control (e.g. checkpoint the cursor for a resumable export).
page = client.timeseries.list(symbol="AAPL", interval="1m", limit=10000)
while True:
    for bar in page.data:
        sink.write(bar)
    save_checkpoint(page.next_cursor)      # store opaque cursor → resume later
    if not page.has_more:
        break
    page = page.next_page()                 # SDK re-issues with the stored cursor
```

```typescript
// Node: the spec's pagination annotation lets the generator emit `for await`.
for await (const bar of client.timeseries.list({ symbol: "AAPL", interval: "1m", limit: 1000 })) {
  process(bar);
}
```

### 7.3 What the generator needs from us (the codegen contract)

For an OpenAPI generator (Stainless/Speakeasy/Fern-class) to emit `auto_paging_iter()`/`for await`, the spec must declare the pagination shape. Stainless's config names a request param and a response param:

> *"Stainless's configuration approach defines pagination strategy with cursor-based pagination that specifies `after_cursor` as a request parameter and `next_cursor` as the response parameter."* — ([Stainless, via search](https://www.stainless.com/sdk-api-best-practices/how-to-iterate-paginated-results-in-sdks-examples))

So our contract is:

1. **Request param:** the cursor in (`cursor` / `after_cursor`) — the value the client echoes back.
2. **Response params:** the next cursor out (`next_cursor`) **and** `has_more` (the stop condition).
3. **Items path:** the array the iterator yields (`data`).
4. **Page size:** `limit` with a documented default + max (§5.5).

Keep these field names **identical across every channel** so the generator configures one pagination strategy for the whole API and every client learns one idiom. A drifting envelope (one endpoint `next_cursor`, another `nextToken`, a third `links.next`) forces per-endpoint SDK config and breaks the auto-iterate promise — pick one (we pick `next_cursor` + `has_more` for our JSON channels, with the DataQuery-compatible `links.next` understood for migration, §5.6/§6).

---

## 8. Worked cursor encode/decode (runnable, Postgres/TimescaleDB)

The cursor is the boundary `(ts, id)` of the **last row on the current page**, base64-encoded so it's opaque. Below is a complete, runnable reference implementation (Python 3.12, Pydantic v2 / asyncpg shape — the data-plane's stack).

### 8.1 Encode / decode (opaque, tamper-evident)

```python
# pagination.py — opaque keyset cursor for a (ts DESC, id DESC) sort
import base64
import json
import hmac
import hashlib
from datetime import datetime, timezone
from typing import Any

_CURSOR_SECRET = b"<from-settings; NOT in source>"  # see §8.4

def encode_cursor(ts: datetime, row_id: int) -> str:
    """Encode the last-seen sort key as an opaque, signed, URL-safe token."""
    payload = {
        "ts": ts.astimezone(timezone.utc).isoformat(),  # UTC, unambiguous
        "id": row_id,
        "v": 1,                                          # cursor schema version
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    sig = hmac.new(_CURSOR_SECRET, raw, hashlib.sha256).digest()[:8]
    token = base64.urlsafe_b64encode(sig + raw).decode().rstrip("=")
    return token

def decode_cursor(token: str) -> tuple[datetime, int]:
    """Decode + verify a cursor. Raises on tamper/garbage → caller returns 400."""
    padded = token + "=" * (-len(token) % 4)
    blob = base64.urlsafe_b64decode(padded)
    sig, raw = blob[:8], blob[8:]
    expected = hmac.new(_CURSOR_SECRET, raw, hashlib.sha256).digest()[:8]
    if not hmac.compare_digest(sig, expected):
        raise ValueError("invalid or tampered cursor")
    payload: dict[str, Any] = json.loads(raw)
    if payload.get("v") != 1:
        raise ValueError(f"unsupported cursor version: {payload.get('v')}")
    return datetime.fromisoformat(payload["ts"]), int(payload["id"])
```

**Design notes, each load-bearing:**

- **Base64-url + strip padding** → safe in query strings and `links.next` URLs; matches the *"base64-encoded to obscure"* doctrine ([speakeasy](https://www.speakeasy.com/api-design/pagination), [dev.to](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h)).
- **HMAC signature (8 bytes)** → the cursor is *opaque AND tamper-evident*. A client can't fabricate a boundary to scan arbitrary ranges (a mild access-control + correctness guard). Opaque alone stops *accidental* construction; the HMAC stops *deliberate* construction. Cost is negligible.
- **`v` schema version** → we can evolve the keyset (add `seq` for sub-second ties) and *reject old cursors cleanly* (`unsupported cursor version`) instead of mis-decoding them. Opacity (§5.4) is what makes this evolution non-breaking.
- **ISO-8601 UTC timestamp** → no timezone ambiguity at the boundary; the store compares in UTC.

### 8.2 The page query (tuple comparison, single index range)

```python
# repository.py — one keyset page; relies on INDEX (symbol, ts DESC, id DESC)
import asyncpg

PAGE_SQL = """
    SELECT ts, id, open, high, low, close, volume
      FROM bars
     WHERE symbol = $1
       AND ($2::timestamptz IS NULL OR (ts, id) < ($2, $3))   -- keyset boundary
     ORDER BY ts DESC, id DESC
     LIMIT $4
"""

async def fetch_page(
    conn: asyncpg.Connection,
    symbol: str,
    cursor: str | None,
    limit: int,
) -> tuple[list[asyncpg.Record], str | None, bool]:
    limit = min(max(limit, 1), 10_000)          # clamp to documented max (§5.5)
    if cursor is None:
        ts_boundary, id_boundary = None, 0       # first page: no boundary
    else:
        ts_boundary, id_boundary = decode_cursor(cursor)

    # Fetch one EXTRA row to compute has_more without a COUNT(*).
    rows = await conn.fetch(PAGE_SQL, symbol, ts_boundary, id_boundary, limit + 1)

    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = (
        encode_cursor(page[-1]["ts"], page[-1]["id"]) if has_more and page else None
    )
    return page, next_cursor, has_more
```

**Two techniques worth calling out:**

1. **`($2 IS NULL OR (ts,id) < ($2,$3))`** — one SQL handles both the first page (no cursor → `NULL` → predicate true → start at the top) and every subsequent page (tuple comparison). On Postgres/TimescaleDB the tuple form `(ts, id) < ($2, $3)` plans as a **single index range scan that stops at LIMIT** — *not* the OR-expansion that scans linearly (§4.3, [spring-data-jpa #4250](https://github.com/spring-projects/spring-data-jpa/issues/4250)). Verify once with `EXPLAIN`: you want `Index Cond: (ROW(ts, id) < ROW($2, $3))`, never a `Filter`.
2. **Fetch `limit + 1`, return `limit`** — the standard `has_more` trick. If we got an extra row, there's another page; the extra row is dropped, and the *last returned* row's key becomes `next_cursor`. **No `COUNT(*)`, no second scan** — honoring §5.3 (*"avoids the need to count records"* — [speakeasy](https://www.speakeasy.com/api-design/pagination)).

### 8.3 The FastAPI route (envelope assembly)

```python
# routes/timeseries.py
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()

class Pagination(BaseModel):
    next_cursor: str | None = None
    has_more: bool = False
    # total_count intentionally omitted for series (§5.3)

class TimeseriesPage(BaseModel):
    data: list[Bar]
    pagination: Pagination

@router.get("/timeseries", response_model=TimeseriesPage)
async def get_timeseries(
    symbol: str,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=10_000),   # default + max enforced
    conn=Depends(get_conn),
):
    try:
        rows, next_cursor, has_more = await fetch_page(conn, symbol, cursor, limit)
    except ValueError as e:                  # bad/tampered cursor
        raise HTTPException(status_code=400, detail=f"invalid cursor: {e}")
    return TimeseriesPage(
        data=[Bar.from_record(r) for r in rows],
        pagination=Pagination(next_cursor=next_cursor, has_more=has_more),
    )
```

`limit: int = Query(default=1000, ge=1, le=10_000)` makes FastAPI/OpenAPI enforce the default+max and **publish them into the spec**, so the generated SDK both clamps client-side and configures the auto-iterator (§7). A bad cursor is a clean `400`, never a 500 or — worse — a silently-wrong page.

### 8.4 Operational notes

- **Cursor secret:** load `_CURSOR_SECRET` from `pydantic-settings` (env), shared across all instances so any instance can decode any cursor (stateless paging — essential behind a load balancer). Rotating it invalidates in-flight cursors; bump `v` and accept both keys during a rotation window if that matters.
- **Backward paging:** mirror the query with `(ts, id) > ($2, $3)` + `ORDER BY ts ASC, id ASC`, then reverse the page in-app, and emit a `prev_cursor`. Most series channels are forward-only (history streams one way) and can skip this.
- **Resumable export:** because the cursor is self-contained and opaque, a crashed export resumes by replaying the **last persisted `next_cursor`** — no "page number" to recompute, no risk of skip/dupe (§1.3). This is the property offset *cannot* give you and the reason exports must be cursor-paged.

---

## 9. Anti-patterns (mistake → fix)

| # | Anti-pattern | Why it breaks | Fix |
|---|---|---|---|
| 1 | **Offset paging a time-series / large / live collection** | `O(n)` deep-page latency (page 1000 = seconds; [dev.to](https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h)) **and** skip/dupe under concurrent ingest ([getknit](https://www.getknit.dev/blog/api-pagination-techniques)). Tier-3 break. | Cursor/keyset on `(ts, id)` (§2, §8). |
| 2 | **Keyset on a non-unique sort key** (e.g. `ORDER BY ts` only) | Ties at the boundary → rows skipped/duplicated; *"skips all results from yesterday"* ([use-the-index-luke](https://use-the-index-luke.com/sql/partial-results/fetch-next-page)). | Append a unique tiebreaker: sort + cursor on `(ts, id)` (§4.1). |
| 3 | **Naive multi-column boundary** `WHERE ts < ? AND id < ?` | Logically wrong — drops valid rows that have a smaller `ts` but larger `id`. | Row-value tuple comparison `(ts, id) < (?, ?)` (§4.3). |
| 4 | **OR-expansion** `(ts<?) OR (ts=? AND id<?)` on Postgres | Correct but *"a filter scan over millions of rows"* — loses the index range ([spring-data-jpa #4250](https://github.com/spring-projects/spring-data-jpa/issues/4250)). | Emit the tuple form; Postgres/TimescaleDB plan it as one `Index Cond` (§4.3). |
| 5 | **Sort tuple not indexed** | Engine falls back to scan + Sort node; keyset advantage gone, undetected until `EXPLAIN`. | Index matches `ORDER BY` exactly: `(symbol, ts DESC, id DESC)` (§4.2). |
| 6 | **Transparent / parseable cursor** (`?cursor={"id":123}`) | Clients hard-code/fabricate it; you can't evolve the keyset without breaking them ([speakeasy](https://www.speakeasy.com/api-design/pagination)). | Opaque base64 + HMAC + version field (§5.4, §8.1). |
| 7 | **Unbounded `limit`** | One request fetches the universe → OOM/DoS; re-introduces the blowup pagination prevents. | Clamp server-side `min(requested, MAX)`; publish default+max (§5.5). |
| 8 | **`total_count` via live `COUNT(*)` on a series** | A second full scan on the hot path; the very cost cursors avoid ([speakeasy](https://www.speakeasy.com/api-design/pagination)). | Omit it for cursor channels; only ship `total` for bounded offset sets (§5.3). |
| 9 | **Inconsistent envelope across channels** (`next_cursor` here, `nextToken` there, `links.next` elsewhere) | Per-endpoint SDK config; auto-iterate breaks; clients re-learn each endpoint. | One envelope (`data` + `next_cursor` + `has_more`) everywhere (§5, §7.3). |
| 10 | **`COUNT(*)` `+ has_more` instead of `limit+1`** | Extra scan to know if more exist. | Fetch `limit+1`, slice to `limit`, set `has_more = fetched > limit` (§8.2). |
| 11 | **Mixed-direction sort** `ORDER BY ts DESC, id ASC` with tuple comparison | Tuple `<` can't express a mixed-direction boundary → wrong page. | Keep all sort columns one direction (natural for newest-first) (§4.3). |
| 12 | **Offset cursor stored as "page number" for resume** | Page N is a different window after writes → resume skips/dupes (§1.3). | Persist the opaque `next_cursor`; resume by replaying it (§8.4). |

---

## 10. Tier statement (R-SCALE, in writing)

Per `product-scale-architecture.md` §3, every scale surface states the tier it survives and what breaks next:

| Surface | Offset implementation | This doc's cursor contract |
|---|---|---|
| Time-series read | **Tier 1 only.** Fine at 10k rows / 1 reader. Breaks at 100×: deep pages hit `O(n)` latency; live ingest causes skip/dupe. | **Tier 3.** `O(log N)` flat latency at any depth; consistent under continuous writes; resumable export. |
| Catalogue / discovery | **Tier 2–3 OK.** Set is bounded (hundreds–low thousands), rarely changes; offset never reaches its degradation regime. | Cursor would also work but is unnecessary; offset's page-number UX is a feature here. |

**The failure this prevents (the rule's whole point):** shipping the *offset* time-series endpoint, watching it pass every demo (because the demo has 1,000 rows), and *believing it's production-ready*. It is a Tier-1 implementation wearing a Tier-3 costume. The cursor contract above is what makes the series channel actually Tier-3 — and it costs ~50 lines (§8), paid once, up front, instead of a sale-day-equivalent incident later.

---

## Sources

Primary docs & library source read for this doc:

- **use-the-index-luke.com — "We need tool support for keyset pagination" / no-offset** — Markus Winand on why OFFSET fetches+discards, the SQL:2023 definition, drift under inserts, the seek-method filter. <https://use-the-index-luke.com/no-offset>
- **use-the-index-luke.com — Fetch the Next Page (seek method SQL)** — `(sale_date, sale_id) < (?, ?)` row-value comparison, the index requirement `CREATE INDEX … (sale_date, sale_id)`, why `ts <` alone is wrong. <https://use-the-index-luke.com/sql/partial-results/fetch-next-page>
- **engineeringatscale.substack.com — API Pagination: Techniques & Best Practices** — `O(N)` vs `O(1)`, the offset+limit/sort/drop steps, B-tree `O(log N)` seek, flat deep-page latency. <https://engineeringatscale.substack.com/p/api-pagination-limit-offset-vs-cursor>
- **dev.to (reclusivecoder, Gusto-derived) — Offset vs. Cursor-Based** — the `LIMIT/OFFSET` SQL, page-1-vs-1000 latency, the shifting-data worked example, `(created_at, id) < (...)` cursor SQL, base64 cursor, the `next_cursor`/`has_more`/`prev_cursor` envelope, Gusto's real offset+cursor endpoints. <https://dev.to/reclusivecoder/a-developers-guide-to-api-pagination-offset-vs-cursor-based-2m5h>
- **embedded.gusto.com/blog/api-pagination** — Gusto Embedded's production offset-for-stable / cursor-for-changing split; "OFFSET 10000 scans and discards 10,000 rows"; "cost grows linearly with offset." <https://embedded.gusto.com/blog/api-pagination/>
- **speakeasy.com/api-design/pagination** — envelope (`next_cursor`, `has_more`, `links.self/next`), opaque/base64 cursors ("stop API consumers hard-coding values"), cursor as a "stable marker", "avoids the need to count records." <https://www.speakeasy.com/api-design/pagination>
- **getknit.dev — API Pagination Techniques** — offset skips/duplicates vs cursor stable boundaries; cursor "more reliable for integration sync loops"; when to use each. <https://www.getknit.dev/blog/api-pagination-techniques>
- **restguide.info/pagination** — the `data`/`cursors{next,prev}`/`has_more` and `offset`/`limit`/`total` envelopes; `limit=20` default / `max_limit=100`; offset for "small datasets, admin panels". <https://restguide.info/pagination>
- **jpmorganchase/dataquery-sdk (GitHub README)** — catalogue/discovery methods with `limit`/`offset`/`page`; the `DATAQUERY_REQUESTS_PER_MINUTE`/`BURST_CAPACITY` rate budget. <https://github.com/jpmorganchase/dataquery-sdk>
- **macrosynergy DataQuery client source** — the `links[1].next` recursive continuation in `_fetch()`, the `TIMESERIES_ENDPOINT`/`CATALOGUE_ENDPOINT`/base-URL constants. <https://docs.macrosynergy.com/latest/_modules/macrosynergy/download/dataquery.html>
- **Stripe — Auto-pagination** — `auto_paging_iter()` (Python), `for await` (Node), per-language auto-paginate calls; `has_more` + `starting_after` underlying shape. <https://docs.stripe.com/api/pagination/auto>
- **Stainless — How to Iterate Paginated Results in SDKs** — auto-iterate vs manual page-by-page; `after_cursor` request param / `next_cursor` response param codegen contract. <https://www.stainless.com/sdk-api-best-practices/how-to-iterate-paginated-results-in-sdks-examples>
- **spring-projects/spring-data-jpa #4250** — row-value tuple comparison plans as a single index range on Postgres/MySQL/H2/CockroachDB/MariaDB; the OR-expansion "filter scan over millions of rows"; dialect `supportsRowValueConstructorGtLtSyntax()`. <https://github.com/spring-projects/spring-data-jpa/issues/4250>
