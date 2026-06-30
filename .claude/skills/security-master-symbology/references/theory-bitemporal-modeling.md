# theory-bitemporal-modeling — the two-timeline foundation of identity-over-time

> **Skill:** `security-master-symbology` (JPM-Markets re-engineering **data-analytics product line**, NOT Lumina).
> **Type:** `theory-*` — generic, reusable, implementation-neutral. The conceptual model that every
> schema and every query in this subsystem is built on. The concrete Postgres DDL, the index plan, the
> `tstzrange`/exclusion-constraint mechanics, the `merge_asof` join recipes — all of that lives in the
> `patterns-*` references. **This document is the *why*; those are the *how-on-Postgres*.**
>
> **Read this first, before any other reference in this skill.** A security master that gets the temporal
> model wrong does not fail loudly — it fails silently, by quietly overwriting what it used to believe, and
> you only discover the loss months later when an auditor, a regulator, or a backtest asks "what did the
> data say on that day?" and the honest answer is "we no longer know." Everything else this skill teaches —
> symbology cross-reference, corporate-action chaining, golden-copy mastering — sits on top of the
> bitemporal substrate. If the substrate is single-timeline, the whole master is one bad correction away
> from amnesia.

---

## 0. The one-paragraph mental model (read this even if you read nothing else)

Every fact about a security has **two** independent dates attached to it, not one. **Valid time** is *when
the fact is true in the world* — the day Facebook actually renamed itself Meta, the day a stock split
1-for-20, the day a CUSIP was reassigned. **Transaction time** (a.k.a. knowledge time, system time, record
time) is *when our database came to believe that fact* — the day the corporate-action feed delivered it,
the day an analyst keyed in a correction. These two clocks run independently: we can learn *today* (transaction
time) about something that became true *last March* (valid time), and we can learn *today* about something that
will become true *next month*. A correct security master stores **both** axes on **every** version of **every**
attribute, never updates a row in place, and answers four distinct question shapes: *what is true now*, *what was
true on date X (valid)*, *what did we believe on date Y (transaction)*, and the one that only bitemporality can
answer — *what did we believe **on date Y** about **date X**.* The worked finance example that the whole
subsystem exists to handle: on 31-Mar a price was recorded as **\$185.16**; in late November we discovered it
should have been **\$188.16** and corrected it *for the 31-Mar valid date*. A bitemporal store lets you retrieve
**both** — the \$185.16 we reported in our Q1 filing *and* the \$188.16 we know today — without one destroying the
other. ([Indus Valley Partners, "Security and Reference Master: Bitemporal Point-in-Time
Data"](https://www.ivp.in/resources/blogs/security-and-reference-master-bitemporal-point-in-time-data/).)

That's the entire game. The rest of this document earns those sentences.

---

## 1. The two timelines, precisely

### 1.1 The definitions, from the source

The two time dimensions are not a vendor invention; they are the standard vocabulary of temporal databases,
formalized in the academic literature (Snodgrass, Jensen et al.) and adopted into SQL:2011. The Wikipedia
*Temporal database* article gives the canonical one-line definitions:

- **Valid time** is *"the time period during [which] or event time at which a fact is true in the real
  world."* ([Wikipedia, *Temporal database*](https://en.wikipedia.org/wiki/Temporal_database).)
- **Transaction time** is *"the time at which a fact was recorded in the database."* (same source.)

Finance practitioners use a different vocabulary for the *same two axes* — and you must be able to translate,
because every vendor doc, every regulator, and every old data-warehouse team uses its own pair of words:

| Generic / SQL:2011 term | Finance / IVP term | Martin Fowler's term | XTDB term | What it answers |
|---|---|---|---|---|
| **Valid time** | **Effective date** | **Actual time** | **valid time** (`ts`) | *When is/was the fact true in the world?* |
| **Transaction time** | **Knowledge date** | **Record time** | **transaction time** (`tx-ts`) | *When did we record / come to know it?* |

Indus Valley Partners states the finance pairing directly: *"Bitemporal data denotes values of data
corresponding to two dimensions of time: knowledge date and effective date,"* where the **knowledge date** is
*"the date on which the data is entered into the application"* and the **effective date** is *"the date for
which the data is being maintained within the application itself."*
([IVP, "Bitemporal: Point-in-Time Reference Data
Management"](https://www.ivp.in/resources/blogs/bitemporal-point-in-time-reference-data-management/).)

Martin Fowler frames the same pair as **actual time** ("when something actually happened in the real world")
versus **record time** ("when we learned about or recorded that event"), and states the load-bearing insight
in one sentence: *"Whenever something happens, there are always these two times that come with it."*
([Martin Fowler, *Patterns for things that change with time*](https://martinfowler.com/eaaDev/timeNarrative.html).)

> **Naming discipline for this subsystem.** This skill standardizes on the generic, regulator-legible pair
> **valid time** / **transaction time** in prose and on the column names `valid_from` / `valid_to` and
> `tx_from` / `tx_to` in schema (rationale in §4). When you read an IVP/finance doc that says "effective /
> knowledge," translate to "valid / transaction" in your head — they are the same axes.

### 1.2 The two axes are *independent* — this is the whole point

The decisive property — the reason you cannot collapse the two into one — is **independence**: a write can
land *anywhere* on the valid-time axis regardless of where it lands on the transaction-time axis. Concretely:

- **You can write today about the past (valid).** A correction discovered in November that applies to a
  March valid date is a *retroactive* write: transaction time = now, valid time = March.
- **You can write today about the future (valid).** A known-in-advance index reconstitution effective next
  Monday is a *proactive* write: transaction time = now, valid time = next Monday.
- **Transaction time, by contrast, only ever moves forward.** You cannot rewrite history's *record* — you
  can only append a new record that says "as of now, here is the corrected view." XTDB states this hard
  constraint explicitly: *"You cannot write a new transaction with a `transaction-time` that is in the
  past."* ([XTDB, *Bitemporality*](https://v1-docs.xtdb.com/concepts/bitemporality/).)

XTDB also names the exact situation that makes both axes mandatory for a security master — *the database is
not the system of record for the truth*:

> *"In situations where your database is not the ultimate owner of the data — where corrections to data can
> flow in from various sources and at various times — use of transaction-time is inappropriate for historical
> queries."* ([XTDB, *Bitemporality*](https://v1-docs.xtdb.com/concepts/bitemporality/).)

This is *exactly* a security master's situation. The truth about a CUSIP reassignment lives at the exchange
and at CUSIP Global Services; the truth about a split lives at the issuer and DTCC; we are a **downstream
aggregator** that receives those truths late, sometimes out of order, sometimes wrong-then-corrected. A
single timeline cannot represent "we believed X, then learned X was wrong, and need to keep both."

### 1.3 The 2-D grid intuition

Because the axes are independent, the full history of one attribute is not a *line* (a sequence of versions);
it is a **plane**. Fowler captures this exactly: bitemporal data means *"not just is there a history of
[the] pay rate for every day in the past, but there is a history of histories"* — a *"two-dimensional grid
where each combination of actual and record dates requires potentially different answers."*
([Martin Fowler, *Patterns for things that change with time*](https://martinfowler.com/eaaDev/timeNarrative.html).)

```
                          VALID TIME  (when the fact is true in the world)  ──────►
                    Jan          Feb          Mar          Apr          May
T  ┌──────────────────────────────────────────────────────────────────────────────┐
R  │  As we believed                                                                │
A  │  on 31-Mar         ...        ...     price=185.16     ...          ...         │ ← transaction-slice "31-Mar"
N  │                                                                                │
S  │  As we believe                                                                 │
A  │  on 30-Nov (after  ...        ...     price=188.16     ...          ...         │ ← transaction-slice "30-Nov"
C  │  the correction)                                                               │
T  │                                                                                │
I  │  ▲                                                                             │
M  │  │ transaction time only moves DOWN (forward); you append, never overwrite     │
E  └──────────────────────────────────────────────────────────────────────────────┘
   ▼
```

A query is a *coordinate* (or a *region*) on this plane:
- *current/current* = bottom-right corner (latest transaction, now valid).
- *as-of valid* = a vertical line at one valid date, read at the latest transaction row.
- *as-of transaction* = a horizontal slice — "rewind what we believed to date Y."
- *fully bitemporal* = a single cell — "on 30-Nov, what did we believe about 31-Mar?"

Hold this grid in your head; §5 turns each region into a query archetype.

---

## 2. The four temporal table types (SQL:2011)

SQL:2011 — the version of the ISO SQL standard that added temporal support — defines temporal capability
along the same two axes, yielding **four table shapes**. The Wikipedia *Temporal database* and *SQL:2011*
articles enumerate them; cross-verified against the *illuminatedcomputing* "Survey of SQL:2011 Temporal
Features" and Microsoft's SQL Server / MariaDB docs (full citations inline below).

| # | Table type (SQL:2011 name) | Tracks valid? | Tracks transaction? | What it's for |
|---|---|---|---|---|
| 1 | **Non-temporal** | ✗ | ✗ | A plain row; "current truth only," history destroyed on update. |
| 2 | **Application-time period table** | ✓ | ✗ | Business/effective-dated history *only* (valid time). |
| 3 | **System-versioned table** | ✗ | ✓ | Audit/"what did the DB hold" history *only* (transaction time). |
| 4 | **System-versioned application-time period table** = **bitemporal** | ✓ | ✓ | Both axes — the security master's required shape. |

The Wikipedia *Temporal database* article states it plainly: SQL:2011 *"included clauses to define
'application-time period tables' (valid time tables), 'system-versioned tables' (transaction time tables)
and 'system-versioned application-time period tables' (bitemporal tables)."*
([Wikipedia, *Temporal database*](https://en.wikipedia.org/wiki/Temporal_database).)

### 2.1 The `PERIOD FOR` mechanism (and the TSQL2 contrast)

SQL:2011's key syntactic move is the **`PERIOD FOR`** declaration: it *binds two ordinary columns* into a
named period, rather than introducing a hidden interval type. Wikipedia: *"two columns with datestamps (DS)
or date-timestamps (DTS) can be bound together using a `PERIOD FOR` declaration,"* and — the deliberate
design difference from the earlier rejected TSQL2 proposal — *"there are no hidden columns in the SQL:2011
treatment, nor does it have a new data type for intervals."*
([Wikipedia, *Temporal database*](https://en.wikipedia.org/wiki/Temporal_database).)

That last point matters for us: the period is **two visible columns**, so a security master built on
SQL:2011 (or on a hand-rolled SCD2 that imitates it — §4) stores `valid_from`/`valid_to` and
`tx_from`/`tx_to` as **real, queryable, indexable columns**. You are never at the mercy of a black-box
interval type; you can build your own exclusion constraints and your own as-of joins on them.

### 2.2 Application-time period table (valid only) — exact syntax

The *valid* axis is declared by an application period and (crucially) protected by a temporal primary key.
From the illuminatedcomputing survey of SQL:2011:

```sql
CREATE TABLE t (
  id         INTEGER,
  valid_from DATE,
  valid_til  DATE,
  PERIOD FOR valid_at (valid_from, valid_til)
);

-- temporal primary key: same business key may not OVERLAP in valid time
ALTER TABLE t ADD PRIMARY KEY (id, valid_at WITHOUT OVERLAPS);

-- valid-time DML that splits/trims existing periods automatically
UPDATE t FOR PORTION OF valid_at FROM t1 TO t2 SET ...;
DELETE FROM t FOR PORTION OF valid_at FROM t1 TO t2;
```

([illuminatedcomputing, *Survey of SQL:2011 Temporal
Features*](https://illuminatedcomputing.com/posts/2019/08/sql2011-survey/).) The
`PRIMARY KEY (id, valid_at WITHOUT OVERLAPS)` clause is the standard's built-in *no two versions of the same
key may overlap in valid time* guarantee — the integrity rule we re-create by hand in §7.2 on databases that
lack it.

> **`FOR PORTION OF` is the standard's killer feature and the reason valid-time history is hard to hand-roll
> correctly.** When you `UPDATE ... FOR PORTION OF valid_at FROM '2025-03-01' TO '2025-04-01'`, the engine
> *splits* any wider existing row at those boundaries, so the change applies to exactly that sub-interval and
> the before/after slices keep their old values. Doing this manually is the single most bug-prone part of a
> hand-rolled temporal master — the patterns doc shows the explicit split/trim logic.

### 2.3 System-versioned table (transaction only) — exact syntax

The *transaction* axis is system-maintained: the engine stamps the period columns; the application never
sets them. SQL:2011 standard form (per illuminatedcomputing):

```sql
CREATE TABLE t (
  id      INTEGER,
  sys_from TIMESTAMP GENERATED ALWAYS AS ROW START,
  sys_til  TIMESTAMP GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (sys_from, sys_til)
) WITH SYSTEM VERSIONING;

SELECT * FROM t FOR SYSTEM_TIME AS OF TIMESTAMP '2025-03-31 00:00:00';
SELECT * FROM t FOR SYSTEM_TIME BETWEEN t1 AND t2;
```

([illuminatedcomputing, *Survey of SQL:2011 Temporal
Features*](https://illuminatedcomputing.com/posts/2019/08/sql2011-survey/).)

Microsoft SQL Server implements exactly this shape, and its docs are the most concrete primary source for the
**mechanics of each DML operation** — worth reading even if you never touch SQL Server, because it documents
precisely *what the engine does on insert/update/delete*, which is the behavior you must reproduce by hand on
Postgres (§4):

```sql
CREATE TABLE dbo.Employee
(
    [EmployeeID]   INT NOT NULL PRIMARY KEY CLUSTERED,
    [Name]         NVARCHAR(100) NOT NULL,
    [Position]     VARCHAR(100)  NOT NULL,
    [ValidFrom]    DATETIME2 GENERATED ALWAYS AS ROW START,
    [ValidTo]      DATETIME2 GENERATED ALWAYS AS ROW END,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo)
)
WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.EmployeeHistory));
```

The documented per-operation behavior (this is the SCD2 algorithm, system-enforced):

- **Insert:** *"the system sets the value for the `ValidFrom` column to the begin time of the current
  transaction (in the UTC time zone) … and assigns the value for the `ValidTo` column to the maximum value
  of `9999-12-31`. This marks the row as open."*
- **Update:** *"the system stores the previous value of the row in the history table and sets the value for
  the `ValidTo` column to the begin time of the current transaction … This marks the row as closed … In the
  current table, the row is updated with its new value and the system sets the value for the `ValidFrom`
  column to the begin time for the transaction … The value for the updated row … for the `ValidTo` column
  remains the maximum value of `9999-12-31`."*
- **Delete:** *"the system stores the previous value of the row in the history table and sets … `ValidTo` …
  to the begin time of the current transaction … In the current table, the row is removed."*

([Microsoft Learn, *Temporal Tables - SQL
Server*](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables).)

Note three things you must replicate when hand-rolling:
1. **The open-row sentinel is `9999-12-31`** (the engine's max). §6 and §7 cover sentinel choice.
2. **The timestamp is the *transaction begin time in UTC*, not `now()` per statement** — so all rows in one
   transaction share one consistent stamp. (Microsoft: *"all rows inserted within a single transaction have
   the same UTC time recorded."*) This is a correctness property, not a nicety — see §7.3.
3. **History is a separate physical table** in SQL Server's model. Hand-rolled SCD2 usually keeps current and
   history in **one** append-only table (§4) — a design choice, not a law.

MariaDB implements the same SQL:2011 system-versioning and additionally supports application-time periods and
`FOR PORTION OF` DML, making it the closest single open-source engine to "real bitemporal SQL:2011"
([MariaDB, *System-Versioned
Tables*](https://mariadb.com/docs/server/reference/sql-structure/temporal-tables/system-versioned-tables);
cross-checked against illuminatedcomputing's support matrix below).

### 2.4 Bitemporal table (both) — and the database-support reality

A bitemporal table is simply **both period declarations on one table**: one application period for valid
time, one system period for transaction time. Conceptually:

```sql
CREATE TABLE security_attr (
  security_id  BIGINT,
  attr_value   TEXT,
  -- valid time (application period) — set by us, can be back/forward-dated
  valid_from   DATE,
  valid_to     DATE,
  PERIOD FOR valid_at (valid_from, valid_to),
  -- transaction time (system period) — set by the engine, forward-only
  tx_from      TIMESTAMP GENERATED ALWAYS AS ROW START,
  tx_to        TIMESTAMP GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (tx_from, tx_to),
  PRIMARY KEY (security_id, valid_at WITHOUT OVERLAPS)
) WITH SYSTEM VERSIONING;
```

**The catch, and why this skill leans on hand-rolled SCD2:** *almost no production engine implements full
bitemporal SQL:2011.* The illuminatedcomputing survey's support matrix (cross-verified against the Postgres
wiki's `SQL2011Temporal` page and the vendor docs) is sobering:

| Feature | MariaDB | DB2 | Oracle | SQL Server | PostgreSQL (core) |
|---|---|---|---|---|---|
| Application-time `PERIOD` (valid) | Yes | Yes (`BUSINESS_TIME`) | Yes | **No** | **No** (core, as of 18) |
| System-time versioning (transaction) | Yes | Yes | No | Yes | **No** (core) |
| Temporal primary keys (`WITHOUT OVERLAPS`) | No | Yes | No | n/a | **No** (core) |
| `FOR PORTION OF` DML | Yes | Yes | No | n/a | **No** (core) |
| Period predicates (`OVERLAPS`/`CONTAINS` in `WHERE`) | No | No | No | No | n/a |

([illuminatedcomputing, *Survey of SQL:2011 Temporal
Features*](https://illuminatedcomputing.com/posts/2019/08/sql2011-survey/);
[PostgreSQL wiki, *SQL2011Temporal*](https://wiki.postgresql.org/wiki/SQL2011Temporal).)

Read that bottom row: *no single engine gives you both axes + temporal PK + `FOR PORTION OF` natively.* DB2
is closest (both axes, temporal PK). **PostgreSQL core has none of the SQL:2011 temporal DDL** — which is
exactly why this subsystem, built on Postgres, implements bitemporality as **hand-rolled SCD2** (§4) using
ordinary columns + `tstzrange`/`daterange` exclusion constraints. The standard tells you the *shape*; Postgres
makes you *build* it. The schema patterns doc is where that build lives.

---

## 3. Why a security master MUST be bitemporal (the finance argument)

A skeptic's reasonable question: *isn't one history enough? Just keep valid-time versions — when something
changes, close the old version and open a new one. Why pay for a second axis?* The answer is the one fact a
single timeline structurally cannot represent: **what we used to believe.**

### 3.1 The information a single timeline destroys

IVP names the failure mode of a one-timeline ("unitemporal") system precisely. When you correct historical
data in a valid-time-only store, you *"rectify the historical record of data for the timeframe in which
inaccurate reference data was provided,"* and in doing so you *"erase the previous record that was once
thought of as correct."*
([IVP, "Bitemporal: Point-in-Time Reference Data
Management"](https://www.ivp.in/resources/blogs/bitemporal-point-in-time-reference-data-management/).)

That erasure is the bug. The moment you overwrite "we believed \$185.16" with "actually it's \$188.16," you
have **deleted the answer to "what did our Q1 report say?"** — and that answer is not optional in finance. It
is the thing the regulator, the auditor, the client-dispute desk, and the backtest all ask for.

### 3.2 The four parties who require "what did we believe, as-of"

1. **Regulators & auditors.** The core regulatory question is not "what is true now" but *"what did your
   data say, as-of the knowledge-date on which you acted / reported?"* A trade was booked, a NAV was struck,
   a filing was made **using the data we held at that moment**. To defend (or reconstruct) that action, you
   must reproduce the *transaction-time slice* the action ran on. IVP: bitemporal PIT data is *"immensely
   valuable in avoiding issues with clients, auditors, and regulators,"* and the regulatory driver is
   explicit — *"complying [with] new regulations and audits where the user might want to preserve both
   records."*
   ([IVP, "Security and Reference Master: Bitemporal Point-in-Time
   Data"](https://www.ivp.in/resources/blogs/security-and-reference-master-bitemporal-point-in-time-data/).)
   IVP further notes regulators themselves rely on this property to *"rapidly replay market and stock
   trading … for fraudulent activity, and to trace behaviors over time."* (same source.)

2. **Backtests & research (point-in-time correctness / no look-ahead bias).** A backtest run "as if it were
   31-Mar" must see *only what was knowable on 31-Mar* — the \$185.16, not the November-corrected \$188.16.
   Feeding the corrected value into a 31-Mar simulation is **look-ahead bias**: the model "knows the future
   correction," inflating measured performance and producing a strategy that cannot exist in live trading.
   The transaction-time axis is the *only* mechanism that lets you ask "give me the data **as we knew it**
   on 31-Mar." (This is why quant data vendors sell "point-in-time" datasets at a premium; see [vBase,
   *Financial data must be made
   point-in-time*](https://www.vbase.com/blog/financial-data-must-be-made-point-in-time/) for the bias
   argument.)

3. **Operations & client disputes.** "Your statement on 5-Apr showed CUSIP X; now it shows Y — which is
   right?" is answerable *only* if you stored both the value and *when you came to believe each*. Bitemporal
   turns a forensic argument into a `SELECT`.

4. **Downstream reconciliation.** Because the master is a downstream aggregator (XTDB's "not the ultimate
   owner" case, §1.2), late and out-of-order corrections are the *normal* input, not the exception. Without
   transaction time, every late correction silently rewrites the past and breaks reconciliation against
   anyone who consumed the earlier view.

### 3.3 The principle stated once

> A security master's job is not to hold *the truth*. It is to hold **a faithful, replayable record of every
> truth it has ever believed and when it believed it.** Valid time records *what was true*; transaction time
> records *what we knew, and when*. A regulator can ask for either, or for the cell where they cross — and
> "we overwrote it" is never an acceptable answer.

This is the single sentence that justifies the entire cost of the second axis. Every design decision in the
patterns docs traces back to it.

---

## 4. SCD2 as the practical implementation

Since Postgres core gives us no SQL:2011 temporal DDL (§2.4), we implement bitemporality with the oldest,
most battle-tested data-warehouse pattern: **Slowly Changing Dimension, Type 2 (SCD2)** — generalized to two
axes. The Software Patterns Lexicon describes the bitemporal SCD as *"a design pattern for tracking both valid
time and transaction time in the context of Slowly Changing Dimensions."*
([Software Patterns Lexicon,
*Bitemporal Modeling*](https://softwarepatternslexicon.com/bitemporal-modeling/).)

### 4.1 The four rules of bitemporal SCD2

1. **Append-only. Never `UPDATE` a business column, never `DELETE` a row.** Every change is a *new row*. The
   Lexicon: SCD2 *"involves maintaining a complete historical record of data changes by adding a new row for
   each change … Each modification creates a new row rather than updating existing ones, preserving the
   complete audit trail across both time dimensions."* (same source.) "Closing" an old version means setting
   its *end* period column — which on the transaction axis is itself an append in spirit (you stamp `tx_to`
   to mark "we stopped believing this at time T"), and the value columns are never touched.

2. **Four period columns per row.** Valid: `valid_from`, `valid_to`. Transaction: `tx_from`, `tx_to`. The
   Lexicon's naming: valid-time `ValidFrom`/`ValidTo` ("the business period when data applies") and
   transaction-time `TransactionStart`/`TransactionEnd` ("the period the record existed in the database").
   (same source.) This skill standardizes on `valid_from/valid_to` + `tx_from/tx_to`.

3. **Half-open intervals `[from, to)`** — start inclusive, end exclusive (§7.1 proves why).

4. **Open-ended via a sentinel.** The currently-true, currently-believed version has an *open* end on both
   axes. Two conventions exist (§6.3): a **far-future sentinel** (`9999-12-31` for dates, the SQL-Server
   choice) or **`NULL`**. The Lexicon documents the sentinel approach: *"Using special values to represent
   unknown or ongoing valid times, typically by setting a far-future date like `9999-12-31`, to handle
   records with indefinite validity."* (same source.)

### 4.2 The canonical row shape (implementation-neutral)

```
security_attr_history
┌──────────────┬────────────┬────────────┬──────────────┬──────────────────────┬──────────────────────┐
│ security_id  │ attr_name  │ attr_value │ valid_from   │ valid_to             │ tx_from   tx_to      │
│  (business   │            │            │ valid_to     │  (half-open  [from,to))                     │
│   key)       │            │            │  excl.)      │                                            │
└──────────────┴────────────┴────────────┴──────────────┴──────────────────────┴──────────────────────┘
  + a surrogate version id (e.g. bigserial) as the technical PK; the business key is (security_id, attr_name)
```

- **Business key**: `(security_id, attr_name)` — the thing whose history we track.
- **Technical PK**: a surrogate `version_id` — because the *same* business key appears on many rows.
- **A row's meaning**: *"For business key K, the value was V during valid window `[valid_from, valid_to)`,
  and we believed that during transaction window `[tx_from, tx_to)`."* A row with both windows open
  (`valid_to = +∞`, `tx_to = +∞`) is "the current truth as we currently believe it."

### 4.3 The two writes that matter

**A normal new fact** (e.g. an attribute genuinely changes value in the world on a date):
- Close the prior **valid** version: set its `valid_to` to the new change date.
- Insert the new value with `valid_from = change date`, `valid_to = +∞`.
- Both writes happen in one transaction at one `tx_from = now`, prior `tx_to` stays open *unless the prior
  belief itself is being revised*.

**A correction** (we discover a *past* version was wrong) — the bitemporal move, detailed in §6:
- **Do not touch the value of the old row.** Instead, *close its transaction window*: set the wrong row's
  `tx_to = now`. It now reads "we believed this from when-we-recorded-it until now."
- **Insert a new row** with the corrected value, the *same valid window* as the wrong row, and a *fresh*
  transaction window `tx_from = now`, `tx_to = +∞`.
- Result: both beliefs survive. Queries at the old transaction time still see the wrong-but-then-believed
  value; queries now see the corrected one. **Nothing is destroyed.**

### 4.4 Why SCD2, not full SQL:2011, for *this* subsystem

| Want | SQL:2011 native | Hand-rolled bitemporal SCD2 on Postgres |
|---|---|---|
| Both axes on one table | Only DB2 (and only partly) | Yes — four plain columns |
| Runs on our Postgres stack | No (core lacks all of it) | **Yes** |
| Temporal PK / no-overlap guard | `WITHOUT OVERLAPS` (DB2/MariaDB-app only) | Yes — `EXCLUDE` constraint (§7.2) |
| Valid-time split on partial update | `FOR PORTION OF` | Hand-written split logic (patterns doc) |
| Auditor can read the columns | Period columns visible | Yes — they're ordinary columns |
| Portable / no engine lock-in | No | Yes |

The trade is explicit: SQL:2011 would *give* us `FOR PORTION OF` and `WITHOUT OVERLAPS`; hand-rolled SCD2
makes us *write* the split logic and the exclusion constraint ourselves — in exchange for running on the
Postgres we already have, with auditor-legible columns and zero engine lock-in. For a downstream master that
must run on commodity Postgres, that's the right trade. The patterns doc implements every piece.

---

## 5. The four query archetypes

The plane in §1.3 has exactly four useful read shapes. Every report, screen, backtest feed, and audit pull is
one of them. (Predicates below use half-open `[from, to)` semantics, §7.1, and the SQL-Server `AS OF`
algebra, which Microsoft documents exactly:
*"a row … is deemed valid if the [start] value is less than or equal to the … parameter value, and the [end]
value is greater than the … parameter value."*
[Microsoft Learn, *Temporal
Tables*](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables).)

### 5.1 Current / current — "what is true now, as we believe now"

The everyday read. Both windows open.

```sql
SELECT security_id, attr_name, attr_value
FROM   security_attr_history
WHERE  valid_to = 'infinity'        -- or = '9999-12-31'
  AND  tx_to    = 'infinity';
```

This is the "give me today's security master" query — the 99% case for live screens and order routing.

### 5.2 As-of **valid** time — "what was true on valid date X (latest belief)"

Pin the valid axis to a date; read at the *latest* transaction belief. Used by point-in-time reports that
*want* the best-known-today value for a past date (e.g. a restated, corrected historical NAV).

```sql
SELECT security_id, attr_name, attr_value
FROM   security_attr_history
WHERE  valid_from <= :as_of_valid_date          -- start inclusive
  AND  valid_to   >  :as_of_valid_date          -- end exclusive
  AND  tx_to       = 'infinity';                -- latest belief
```

### 5.3 As-of **transaction** time — "what did we believe on knowledge date Y"

Rewind *belief* to date Y; for each business key, return the value whose transaction window contains Y, and
whose valid window is currently true (or pin valid too — see 5.4). This is the **audit replay** of "show me
the master as it stood in our database on 31-Mar."

```sql
SELECT security_id, attr_name, attr_value
FROM   security_attr_history
WHERE  tx_from <= :as_of_tx_time
  AND  tx_to   >  :as_of_tx_time
  AND  valid_to = 'infinity';                   -- "currently-true" rows, as believed at Y
```

XTDB names this exact capability: *"To achieve this you can use `as-of` using `ts` (`valid-time`) and
`tx-ts` (`transaction-time`)."*
([XTDB, *Bitemporality*](https://v1-docs.xtdb.com/concepts/bitemporality/).)

### 5.4 Fully bitemporal — "on knowledge date Y, what did we believe about valid date X"

A single *cell* of the plane: pin **both** axes. This is the query a single timeline literally cannot
express — and the one regulators ask for ("on the day you filed, what did your system say the 31-Mar price
was?").

```sql
SELECT security_id, attr_name, attr_value
FROM   security_attr_history
WHERE  valid_from <= :as_of_valid_date
  AND  valid_to   >  :as_of_valid_date          -- the fact's valid window contains X
  AND  tx_from    <= :as_of_tx_time
  AND  tx_to       >  :as_of_tx_time;           -- and we believed it at Y
```

XTDB's worked statement of this archetype: querying *"all persons who are known to be present in the United
States on day 2 (valid time), as of day 3 (transaction time)"* — the investigation refined by late-arriving
evidence. ([XTDB, *Bitemporality*](https://v1-docs.xtdb.com/concepts/bitemporality/).)

### 5.5 The cheat sheet

| Archetype | Valid predicate | Transaction predicate | The question |
|---|---|---|---|
| current/current | `valid_to = ∞` | `tx_to = ∞` | What is true now (best belief)? |
| as-of valid | `valid_from ≤ X < valid_to` | `tx_to = ∞` | What's the *corrected* value for date X? |
| as-of transaction | `valid_to = ∞` | `tx_from ≤ Y < tx_to` | What did the master hold on date Y? |
| fully bitemporal | `valid_from ≤ X < valid_to` | `tx_from ≤ Y < tx_to` | On Y, what did we believe about X? |

> **Default trap.** If you only ever write the *current/current* query, you have built a non-temporal master
> with extra columns. The value of bitemporality is *entirely* in archetypes 5.3 and 5.4. If no consumer
> ever issues them, you didn't need the second axis — but in a regulated security master, someone *always*
> eventually does, and you cannot retrofit history you never stored.

---

## 6. The worked finance example — the \$185.16 → \$188.16 backdated correction

This is the canonical example the whole subsystem exists to handle, from IVP. We walk it end to end on the
plane.

### 6.1 The scenario (IVP, verbatim numbers)

- **31-Mar**: a price for a security/commodity is recorded as **\$185.16**. Knowledge date (transaction) =
  31-Mar; effective date (valid) = 31-Mar.
- **30-Nov**: someone discovers the 31-Mar price was wrong; the correct value was **\$188.16**. We record the
  correction now (knowledge date = 30-Nov) but it applies to the *31-Mar effective date* (valid = 31-Mar) —
  a **backdated** correction.

IVP states the outcome bitemporality must deliver: the user can *"view the data corresponding to the 31st of
March … as the user thought it was true on the 31st of March … corresponding to \$185.16. With the help of
bitemporality, the user can also view the rectified price of \$188.16 for the 31st of March date by choosing
to view the data as is on the 30th of November"* — and critically, *"without affecting the storage of the
previous value."*
([IVP, "Security and Reference Master: Bitemporal Point-in-Time
Data"](https://www.ivp.in/resources/blogs/security-and-reference-master-bitemporal-point-in-time-data/).)

### 6.2 The rows, before and after (half-open, far-future sentinel)

**State after the original 31-Mar insert** — one open row on both axes:

| version | security_id | attr | value  | valid_from | valid_to     | tx_from | tx_to        |
|---------|-------------|------|--------|------------|--------------|---------|--------------|
| v1      | 42          | px   | 185.16 | 2025-03-31 | 9999-12-31   | 03-31   | 9999-12-31   |

**State after the 30-Nov correction** — the bitemporal move (§4.3): *close v1's transaction window, append
v2 with the corrected value over the same valid window*:

| version | security_id | attr | value  | valid_from | valid_to   | tx_from | tx_to        |
|---------|-------------|------|--------|------------|------------|---------|--------------|
| v1      | 42          | px   | 185.16 | 2025-03-31 | 9999-12-31 | 03-31   | **2025-11-30** |  ← belief closed
| v2      | 42          | px   | **188.16** | 2025-03-31 | 9999-12-31 | **2025-11-30** | 9999-12-31 |  ← corrected belief, open

Three things to notice, because they are the whole lesson:
1. **v1's *value* (\$185.16) was never altered.** Only its `tx_to` moved. The thing we *believed in March* is
   still on disk, byte-for-byte.
2. **Both rows share the valid window `[2025-03-31, ∞)`.** The correction is about *what was true on 31-Mar*,
   so the valid axis is unchanged; only the *belief* changed.
3. **The transaction windows abut but do not overlap**: v1 is believed `[03-31, 11-30)`, v2 is believed
   `[11-30, ∞)`. Half-open intervals make this gap-free and overlap-free automatically (§7.1).

### 6.3 The four archetypes against this data — the proof bitemporality works

| Query | Predicate | Returns | Why |
|---|---|---|---|
| **"price now, as we believe now"** (5.1) | `valid_to=∞ AND tx_to=∞` | **188.16** (v2) | latest belief, currently true |
| **"corrected price for 31-Mar"** (5.2) | valid pin 31-Mar, `tx_to=∞` | **188.16** (v2) | best-known-today for that valid date |
| **"what did our DB say on, e.g., 30-Jun?"** (5.3) | `tx_from ≤ 06-30 < tx_to` | **185.16** (v1) | on 30-Jun we still believed 185.16 |
| **"on 30-Jun, what was the 31-Mar price?"** (5.4) | valid pin 31-Mar + tx pin 30-Jun | **185.16** (v1) | the *cell* — the Q1-filing answer |

That last row is the one a single timeline cannot produce. A valid-only store, on correction, would have
overwritten 185.16 with 188.16 and **lost the answer to "what did we file in Q1?"** Bitemporality keeps it.
This is §3.1's "erase the previous record" failure, prevented.

> **The audit narrative in one line:** *"On the day we made our Q1 regulatory report (a 30-Jun knowledge
> date), our security master stated the 31-Mar price was \$185.16. We discovered and corrected the true value
> to \$188.16 on 30-Nov. Both facts, and the dates we knew them, are on record."* That sentence is only
> *speakable* because both axes were stored.

---

## 7. Pitfalls

### 7.1 Half-open `[from, to)` is mandatory — closed `[from, to]` is a bug

**Use start-inclusive, end-exclusive intervals on *both* axes.** A version valid `[2025-03-01, 2025-04-01)`
covers all of March and *not* 1-Apr; the next version starts *exactly* at `2025-04-01`. The general practice
for SQL-standard temporal databases is closed-open `[start, end)` ([javathinking, *Inclusive vs. Exclusive
Time Interval Ends*](https://www.javathinking.com/blog/is-there-a-standard-for-inclusive-exclusive-ends-of-time-intervals/)),
and Microsoft's SQL Server `AS OF` algebra is literally half-open: *valid iff `start ≤ point AND end >
point`* ([Microsoft Learn, *Temporal
Tables*](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables)).

Why it's not a style preference but a correctness requirement:

- **No-gap, no-overlap is automatic.** If version A ends and version B begins at the *same* instant T, half-open
  means A is `[…, T)` and B is `[T, …)` — T belongs to **exactly one** of them (B). With *closed* intervals
  `[…, T]` and `[T, …]`, instant **T is in both** → an overlap → an as-of query at T returns *two* rows for one
  key → ambiguous truth. The general principle, from the interval literature: *"If both meetings are inclusive,
  they overlap at 3:00 PM exactly … If Meeting A is exclusive (`[2:00, 3:00)`), there's no overlap."*
  ([WebSearch synthesis of interval-convention sources, incl.
  javathinking](https://www.javathinking.com/blog/is-there-a-standard-for-inclusive-exclusive-ends-of-time-intervals/).)
- **Adjacency arithmetic is clean.** `next.valid_from == prev.valid_to` ⇔ they abut with no gap. With closed
  intervals you'd need `next.valid_from == prev.valid_to + 1_unit`, and "+1 unit" is a landmine: +1 *day*? +1
  *microsecond*? The unit leaks into every query. Half-open removes the question.
- **Partitioning a line into versions is exactly the half-open use case.** Like age buckets `[0,10)`,`[10,20)`
  — *"each piece is a half-open interval so that every value falls into exactly one group."* (same synthesis.)

**Convention to write down and never violate:** both `[valid_from, valid_to)` and `[tx_from, tx_to)` are
half-open; the right endpoint is *exclusive*; the open end is a sentinel (`+infinity` / `9999-12-31` / `NULL`).

### 7.2 Overlapping-version prevention must be *enforced by the database*, not by app discipline

The integrity rule — *no two versions of the same business key may overlap in valid time at the same
transaction time* — is the SQL:2011 `PRIMARY KEY (id, valid_at WITHOUT OVERLAPS)` guarantee
([illuminatedcomputing](https://illuminatedcomputing.com/posts/2019/08/sql2011-survey/)). On Postgres, which
lacks `WITHOUT OVERLAPS` in core, you **must** re-create it with an **`EXCLUDE` constraint** over the range
types (the patterns doc gives the exact `EXCLUDE USING gist (security_id WITH =, valid_at WITH &&, tx_at WITH
&&)` DDL). The Software Patterns Lexicon states the rule: *"Ensuring that date ranges for an entity do not
overlap to maintain data integrity."*
([Software Patterns Lexicon](https://softwarepatternslexicon.com/bitemporal-modeling/).)

**Do not** enforce non-overlap in application code with a read-then-write check — that is a classic
race/TOCTOU bug (two concurrent corrections both pass the check, both insert, and now the key has two
"current" versions). The exclusion constraint is the *single ticket window*: the second insert fails atomically
at the database. (This is the temporal analogue of the atomic-guarded-write rule the broader data-analytics
line follows; see the time-series store's ingestion patterns.)

### 7.3 Timezone and instant choice — store UTC, stamp at transaction-begin

Two distinct hazards:

1. **The transaction-time clock must be UTC and consistent within a transaction.** Microsoft's engine records
   *"the begin time of the current transaction (in the UTC time zone)"* so that *"all rows inserted within a
   single transaction have the same UTC time."*
   ([Microsoft Learn, *Temporal Tables*](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables).)
   Reproduce this: stamp `tx_from` once per transaction (Postgres `transaction_timestamp()` /
   `CURRENT_TIMESTAMP`, **not** `clock_timestamp()` which advances mid-statement) and store as `timestamptz`.
   If two rows of one logical change get *different* tx stamps, your as-of-transaction queries (5.3) can land
   *between* them and see a half-applied change.

2. **Valid time has a granularity choice — `date` vs `timestamptz` — and it must match the domain.** Many
   reference attributes (symbol changes, sector reclassifications) are *date-effective* — they change "as of
   the open" on a calendar day; model valid time as `date`. Intraday facts (a tick, an intraday halt) need
   `timestamptz`. Mixing them on one axis (a `date` valid_from against a `timestamptz` valid_to) reintroduces
   the "+1 unit" ambiguity of §7.1. Pick the granularity per attribute family and keep both endpoints the same
   type. Trading-calendar alignment (does `valid_from` mean "from the session open" in which exchange's
   timezone?) belongs to the normalization layer — flagged here, resolved there.

### 7.4 Don't confuse "deleting a row" with "ending a fact"

In an append-only bitemporal store there is **no `DELETE`** of business data. "This security was delisted /
this attribute no longer applies" is recorded by *closing the valid window* (set `valid_to` to the delist
date) and/or *closing the transaction window* on a withdrawn belief — never by removing the row. A literal
`DELETE` destroys exactly the history the subsystem exists to keep, and breaks every as-of query that should
still see the now-ended fact at a past coordinate. (SQL Server models this as a soft-delete into the history
table; we model it as a closed window in the one append-only table — §4.1, §2.3.)

### 7.5 The "current" view is a *projection*, not the table

A frequent design error is to keep a separate, mutable "current security master" table and *also* a history
table, and to `UPDATE` the current table in place. Now you have **two sources of truth** that drift. Correct:
the append-only bitemporal table is the *only* store; "current" is the **query** in §5.1 (or a materialized
view / partial index over `valid_to=∞ AND tx_to=∞`). One table, one truth, many time-coordinates.

---

## 8. When NOT to go full bitemporal — and why this subsystem is the case that needs both

Bitemporality is not free: four extra columns, exclusion constraints, split logic, and every query carries
two extra predicates. Don't pay for the second axis where it earns nothing.

### 8.1 The single-timeline shortcuts (and when each is right)

| Shape | Keep | Drop | Right when… |
|---|---|---|---|
| **Non-temporal** | current value only | all history | The value is *re-derivable* or *disposable* — a hot cache, a denormalized read-model rebuilt from source, scratch/UI state. History adds cost with no consumer. |
| **Valid-time only** (application-period / SCD2-classic) | what was true, when | *what we believed, when* | Corrections are **rare or never**, OR you genuinely don't care what you *used* to believe — e.g. an internal analytics dimension where "always show the best-known value for a past date" is the *only* question and no audit/replay/backtest ever asks "as we knew it then." |
| **Transaction-time only** (system-versioned) | what the DB held, when | *valid/effective dating* | The fact has no meaningful real-world effective date distinct from when you recorded it — a pure write-audit log, a config-change journal. "When did the DB change" is the only question. |
| **Bitemporal** | both | nothing | Corrections happen, **and** someone must replay "what we knew then about a past valid date." |

### 8.2 Why the security master is unambiguously the bitemporal case

Run the master through the test "do corrections happen, *and* must we replay prior belief?":

- **Corrections happen — constantly.** The master is a *downstream aggregator* (§1.2, XTDB's "not the
  ultimate owner"): CUSIP reassignments, late split notifications, restated fundamentals, symbol changes
  discovered after the fact. Late and out-of-order corrections are the *steady state*, not the exception.
- **Prior belief must be replayable — by mandate.** Regulators/auditors (replay the master as-of the
  knowledge date we acted on), backtests (point-in-time, no look-ahead), and client disputes *all* require
  archetype 5.3/5.4. IVP's entire thesis is that this is the security-master use case:
  *"complying [with] new regulations and audits where the user might want to preserve both records for future
  use."* ([IVP](https://www.ivp.in/resources/blogs/security-and-reference-master-bitemporal-point-in-time-data/).)

Both conditions are firmly true. A valid-time-only master would satisfy "give me the corrected 31-Mar price"
but **structurally cannot** answer "what did we report in Q1" — and in a regulated security master, that
second question is not optional. **Therefore: bitemporal, no shortcut, on every mastered attribute.**

### 8.3 Granularity nuance — bitemporal *per attribute family*, not necessarily per column

"Bitemporal on every mastered attribute" does not mean one giant table with one row per (security, every
field). Group attributes that *change together and are corrected together* into one history table (e.g. one
for symbology identifiers, one for classification/sector, one for corporate-action-derived adjustments). A
slowly-changing, rarely-corrected attribute and a fast-moving one don't belong in the same version row, or
every tick of the fast one spawns a redundant version of the slow one. The patterns doc covers this
partitioning; the *principle* is: **bitemporal is per logical fact-family, sized so a change to one field
doesn't needlessly version the others.**

---

## 9. Summary — the contract this theory imposes on the schema and queries

1. **Two independent axes on every mastered fact.** Valid time (effective, when-true-in-world) and
   transaction time (knowledge, when-we-recorded-it). They are orthogonal; writes can be retroactive or
   proactive on valid, forward-only on transaction. (§1)
2. **The shape is SQL:2011 "bitemporal," realized as hand-rolled SCD2** because Postgres core has no temporal
   DDL. Four visible period columns; append-only; never update a value, never delete a fact. (§2, §4)
3. **Half-open `[from, to)` on both axes**, open end as a sentinel; non-overlap enforced by a database
   exclusion constraint, never by app-side read-then-write. (§7.1, §7.2)
4. **Four query archetypes**, of which the two transaction-pinned ones (as-of-transaction, fully-bitemporal)
   are the entire reason the second axis exists — the audit/regulatory/backtest replay. (§5)
5. **The \$185.16 → \$188.16 correction is the acceptance test:** after a backdated correction, all four
   archetypes return the right value, and *nothing is destroyed*. If your design can't reproduce that table
   in §6.2, it isn't bitemporal yet. (§6)
6. **This subsystem needs both axes — no shortcut** — because corrections are the steady state *and* prior
   belief must be replayable by mandate. (§8)

Implementation-neutral by design: the Postgres `daterange`/`tstzrange` columns, the GiST `EXCLUDE`
constraints, the `merge_asof`/lateral-join as-of recipes, and the per-family table layout are the job of the
`patterns-*` references. This document is the model they must faithfully implement.

---

### Sources (all read for this document)

- [Indus Valley Partners — *Bitemporal: Point-in-Time Reference Data Management*](https://www.ivp.in/resources/blogs/bitemporal-point-in-time-reference-data-management/) — finance framing; knowledge/effective date; single-timeline "erase the previous record" failure.
- [Indus Valley Partners — *Security and Reference Master: Bitemporal Point-in-Time Data*](https://www.ivp.in/resources/blogs/security-and-reference-master-bitemporal-point-in-time-data/) — the \$185.16 → \$188.16 worked example; regulator/audit/replay motivation.
- [Wikipedia — *Temporal database*](https://en.wikipedia.org/wiki/Temporal_database) — valid-time/transaction-time definitions; the four SQL:2011 table types; `PERIOD FOR` and the TSQL2 (no-hidden-columns) contrast.
- [Wikipedia — *SQL:2011*](https://en.wikipedia.org/wiki/SQL:2011) — application-time / system-versioned / bitemporal clause names.
- [illuminatedcomputing — *Survey of SQL:2011 Temporal Features*](https://illuminatedcomputing.com/posts/2019/08/sql2011-survey/) — exact SQL:2011 syntax (`PERIOD FOR`, `WITHOUT OVERLAPS`, `FOR PORTION OF`, `GENERATED ALWAYS AS ROW START/END`, `WITH SYSTEM VERSIONING`) + the cross-database support matrix.
- [Microsoft Learn — *Temporal Tables (SQL Server)*](https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables) — concrete system-versioning DDL, per-operation insert/update/delete behavior, the `9999-12-31` sentinel, UTC transaction-begin stamping, and the `AS OF / FROM..TO / BETWEEN / CONTAINED IN / ALL` half-open query algebra.
- [MariaDB — *System-Versioned Tables*](https://mariadb.com/docs/server/reference/sql-structure/temporal-tables/system-versioned-tables) — the closest open-source SQL:2011 temporal implementation (system + application periods).
- [PostgreSQL wiki — *SQL2011Temporal*](https://wiki.postgresql.org/wiki/SQL2011Temporal) — confirmation that Postgres core lacks the SQL:2011 temporal DDL (the reason we hand-roll SCD2).
- [Software Patterns Lexicon — *Bitemporal Modeling*](https://softwarepatternslexicon.com/bitemporal-modeling/) — bitemporal SCD2 as a pattern; `ValidFrom/ValidTo` + `TransactionStart/TransactionEnd`; `9999-12-31` sentinel; append-only; non-overlap rule.
- [Martin Fowler — *Patterns for things that change with time*](https://martinfowler.com/eaaDev/timeNarrative.html) — actual-vs-record time; "two times come with everything"; the "history of histories" 2-D grid; the payroll/back-correction example.
- [XTDB — *Bitemporality*](https://v1-docs.xtdb.com/concepts/bitemporality/) — independence of the axes; "transaction-time cannot be in the past"; the "database is not the ultimate owner" case; `as-of` on `ts`/`tx-ts`; the day-2/day-3 investigation example.
- [javathinking — *Inclusive vs. Exclusive Time Interval Ends*](https://www.javathinking.com/blog/is-there-a-standard-for-inclusive-exclusive-ends-of-time-intervals/) — half-open `[from, to)` as the standard temporal convention and the overlap/adjacency arithmetic argument.
- [vBase — *Financial data must be made point-in-time*](https://www.vbase.com/blog/financial-data-must-be-made-point-in-time/) — the look-ahead-bias / point-in-time argument for the backtest motivation.
