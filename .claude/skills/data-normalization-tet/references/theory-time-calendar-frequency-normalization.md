# theory-time-calendar-frequency-normalization.md

> **Skill:** `data-normalization-tet` · **Type:** theory (generic, reusable across providers)
> **Product line:** JPM-Markets re-engineering **data-analytics** product line (NOT Lumina). A NEW
> Python/FastAPI/data-engineering stack — separate from Lumina's Bun + Express + Prisma + Supabase +
> Upstash stack.
> **Scope — Row/VALUE normalization #2:** reconciling **TIME** across providers. Timezones, trading
> calendars, frequency/periodicity, and point-in-time as-of alignment **without look-ahead**. This is
> the value-level companion to the schema/field-normalization theory: once you know *which series* a
> row belongs to, this doc decides *when* it is and how it lines up against every other series.

---

## 0. The one-paragraph version (read this first)

Every provider stamps its rows with a *time*, and almost every provider lies to you about it in a
different way. One ships naive local-exchange wall-clock with no offset; one ships epoch milliseconds
that are secretly the publisher's receive time, not the exchange's match time; one ships a `DATE` that
means "the trading session that closed", not "midnight UTC"; one ships a quarterly fundamental stamped
with the *period-end* date when the number was not knowable until the *filing* date weeks later. If you
join these naively — `pd.merge` on a `time` column, or `pd.concat` of two frames indexed by
local-wall-clock — pandas will silently pair rows that are hours apart, drop rows that don't exactly
match, or carry a future number backward into the past and call it history. The discipline has exactly
four moves, in order: **(1)** make every datetime tz-aware and convert to a single canonical UTC axis
(retaining the exchange's own tz only as metadata where the *session* carries meaning); **(2)** align
to the right **trading-calendar / business-day grid** so weekends, holidays, and half-days are modeled,
not interpolated over; **(3)** put the series on one **frequency/periodicity** with the correct
operation — `resample` (changes frequency *and aggregates*), `reindex`/`asfreq` (relabels onto a target
index, *no aggregation*), never confusing the two; and **(4)** join across series **point-in-time** with
`merge_asof` (a vectorized, monotonic, last-observation-carried as-of join) so a value is only ever
paired with information that existed *at or before* it — which is the single mechanism that prevents
look-ahead bias and, with delisted rows kept, survivorship bias. Get the order wrong and the errors are
invisible in a demo and catastrophic in a backtest.

**Primary sources used throughout** (read before changing any time-handling code):

- pandas **Time series / date functionality** user guide (the canonical reference for everything below):
  <https://pandas.pydata.org/docs/user_guide/timeseries.html>
- `pandas.merge_asof` API reference (the as-of join):
  <https://pandas.pydata.org/docs/reference/api/pandas.merge_asof.html>
- `pandas.Series.dt.tz_localize` (DST `ambiguous=` / `nonexistent=`):
  <https://pandas.pydata.org/docs/reference/api/pandas.Series.dt.tz_localize.html>
- `pandas.DatetimeIndex.tz_localize`:
  <https://pandas.pydata.org/docs/reference/api/pandas.DatetimeIndex.tz_localize.html>
- `pandas.tseries.offsets.CustomBusinessDay`:
  <https://pandas.pydata.org/docs/reference/api/pandas.tseries.offsets.CustomBusinessDay.html>
- **pandas-market-calendars** (exchange schedules — pandas ships the *machinery* but not the *calendars*):
  <https://pandas-market-calendars.readthedocs.io/en/latest/usage.html> ·
  <https://pypi.org/project/pandas_market_calendars/>
- Databento, **Normalization** (UTC-vs-local-tz in normalized market data):
  <https://databento.com/microstructure/normalization>
- Look-ahead / survivorship / point-in-time definitions:
  <https://corporatefinanceinstitute.com/resources/career-map/sell-side/capital-markets/look-ahead-bias/> ·
  <https://www.quantifiedstrategies.com/survivorship-bias-in-backtesting/> ·
  <https://bookdown.org/palomar/portfoliooptimizationbook/8.2-seven-sins.html>
- Project theory: [`../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md)
  — primitive #1 (Normalize), security master, the write-path TET pattern.

**Version pins (verified 2026-06-24):** pandas **3.0.x** (3.0.0 released 2026-01-21; latest patch 3.0.3,
2026-05-11 — <https://pandas.pydata.org/docs/whatsnew/v3.0.0.html>). **The single most important
pandas-3.0 change for this doc:** datetime parsing **no longer defaults to nanoseconds** — string
parsing now infers resolution, defaulting to **microseconds (`datetime64[us]`)** and falling back to
`ns` only when the string demands it ("The new default resolution when parsing strings is microseconds,
falling back to nanoseconds when the precision of the string requires it" —
<https://pandas.pydata.org/docs/whatsnew/v3.0.0.html>). **Consequence:** never assume a column is
`datetime64[ns]`; converting a `[us]` column to integer gives values **1000× smaller** than a `[ns]`
column. Pin the unit explicitly (`.astype('datetime64[us, UTC]')`) when the integer epoch is
load-bearing. `pandas_market_calendars` is the de-facto exchange-calendar library; `exchange_calendars`
(the fork lineage from `trading_calendars`) is the equivalent alternative — pick one, do not mix.

---

## 1. Why TIME is the hardest value to normalize (the four hazards)

Field/schema normalization (`adjOpen → open`, `from → start_date`) is the easy 20% — a rename. Time is
the hard 80% of the *value* layer because a timestamp is not a label, it is a **claim about reality**
that four independent things can falsify:

| Hazard | What goes wrong | Symptom in the warehouse |
|---|---|---|
| **H1 — Timezone ambiguity** | A datetime with no offset (`2024-03-11 16:00:00`) is meaningless until you know *whose* clock. Provider A means New York close; Provider B means UTC; Provider C means London. | Bars off by 4–5 hours; a "daily close" that lands inside the next session; DST gaps/dupes twice a year. |
| **H2 — Calendar mismatch** | A series defined on the NYSE calendar reindexed onto a naive `freq='D'` grid invents Saturdays, Sundays, and holidays the market never traded. | Phantom rows; `ffill` carrying Friday's close across the weekend as if it were live; half-day (early-close) bars treated as full sessions. |
| **H3 — Frequency confusion** | Using `reindex`/`asfreq` where `resample` was needed (or vice-versa) — relabeling tick data onto a daily grid *drops* 99.99% of it instead of aggregating it into OHLC. | A "daily" series that is actually one random intraday tick per day; or a `resample` silently summing a *level* (price) instead of a *flow* (volume). |
| **H4 — Point-in-time leakage** | Joining a quarterly fundamental by *period-end* date pairs March-31 earnings with a March-31 trade, even though the number was not public until the May filing. | Backtest looks brilliant; live trading does not. The classic, invisible, account-destroying bug. |

The rest of this doc is the four moves that defeat H1→H4, **in dependency order** (you cannot calendar-
align until time is tz-resolved; you cannot frequency-normalize until it's calendar-aligned; you cannot
point-in-time-join until it's frequency-normalized). This ordering *is* the algorithm.

---

## 2. Move 1 — Timezone normalization: every datetime → tz-aware UTC

### 2.1 The principle (and the one exception)

**Rule:** the canonical storage and join axis is **tz-aware UTC**. Convert at the *ingest boundary*
(inside `transform_data` of the TET fetcher — see the project's write-path), never at read time. The
warehouse holds one clock; downstream display localizes back as needed.

Databento, a normalization vendor, states the design directly: *"Exchanges often publish their raw
market data in local timezone, and normalized market data usually adopts a single timezone like UTC or
the local timezone of the trading firm that uses the data"*
(<https://databento.com/microstructure/normalization>). We adopt **UTC** as the single timezone because
our providers span US, Europe, and crypto (24/7) — there is no single "local timezone of the firm" that
serves all of them.

**The one exception — retain the exchange tz as metadata when the *session* carries meaning.** UTC is
correct for the *instant*, but some questions are about the *trading session*, which is a local-calendar
concept: "what was AAPL's close on 2024-03-11?" is a question about the America/New_York session, not
about any UTC midnight. So the canonical model is:

- **`ts_utc`** — `TIMESTAMPTZ` / `datetime64[us, UTC]`: the join axis, always present, always UTC.
- **`exchange_tz`** — a column on the *series metadata* (e.g. `'America/New_York'`, `'Europe/London'`,
  `'UTC'` for crypto): the zone whose *session/calendar* defines this series. Stored once per series,
  not per row.
- **`session_date`** (for EOD/session-grain series) — the local trading-session `DATE` the row belongs
  to, derived as `ts_utc.tz_convert(exchange_tz).date()`. This is the natural key for "the daily bar",
  distinct from the UTC instant.

> **Why both, concretely.** A NYSE early-close half-day (e.g. day after Thanksgiving) closes at 13:00
> America/New_York = 18:00 UTC in winter. If you only stored UTC and bucketed by UTC-midnight, the
> "close" bar straddles the session boundary in the wrong place during DST shoulder weeks. Storing
> `session_date` from the *local* calendar makes "the 2024-11-29 NYSE bar" unambiguous regardless of UTC
> offset that week.

### 2.2 `tz_localize` vs `tz_convert` — the two operations, never interchangeable

This is the #1 source of off-by-hours bugs. From the pandas user guide
(<https://pandas.pydata.org/docs/user_guide/timeseries.html>):

- **`tz_localize(tz)`** — *attaches* a timezone to a **naive** index/series **without moving the
  wall-clock**. It interprets the existing numbers as already being in `tz`.
- **`tz_convert(tz)`** — *converts* an **already-aware** index/series from its current zone to `tz`,
  **moving the wall-clock** to keep the same instant.

```python
import pandas as pd

dti = pd.date_range("2018-01-01", periods=3, freq="h")
# naive: DatetimeIndex(['2018-01-01 00:00:00', '2018-01-01 01:00:00', ...], freq='h')

dti = dti.tz_localize("UTC")
# aware:  '2018-01-01 00:00:00+00:00' ...   (same wall-clock, now tagged UTC)

dti.tz_convert("US/Pacific")
# '2017-12-31 16:00:00-08:00' ...           (wall-clock MOVED back 8h, same instant)
```

(Both blocks verbatim from the pandas user guide,
<https://pandas.pydata.org/docs/user_guide/timeseries.html>.)

**The canonical ingest recipe** for the three real provider shapes:

```python
import pandas as pd

# ── Shape A: provider gives NAIVE local-exchange wall-clock (very common; e.g. many EOD feeds) ──
# You KNOW (from provider docs) the wall-clock is America/New_York. Localize THEN convert.
df["ts_utc"] = (
    pd.to_datetime(df["raw_local"])             # naive datetime64[us]
      .dt.tz_localize("America/New_York",        # attach the TRUE source zone (no clock move)
                      ambiguous="infer",          # DST fall-back: resolve the duplicated hour
                      nonexistent="shift_forward") # DST spring-forward: shift the impossible hour
      .dt.tz_convert("UTC")                        # now move to the canonical axis
)

# ── Shape B: provider gives an OFFSET-bearing string ("2024-03-11T16:00:00-04:00") ──
# Already unambiguous. Parse with utc=True to land directly on UTC.
df["ts_utc"] = pd.to_datetime(df["raw_iso"], utc=True)   # aware, UTC, no localize step

# ── Shape C: provider gives EPOCH integer (seconds / millis / nanos) ──
# Epoch is ALWAYS UTC by definition. Specify the unit; never tz_localize an epoch.
df["ts_utc"] = pd.to_datetime(df["raw_epoch_ms"], unit="ms", utc=True)
```

> **Hard rule:** **never `tz_localize` an epoch integer or an offset-bearing string.** Epoch is UTC by
> definition; an offset string is already aware. `tz_localize` is *only* for naive wall-clock whose true
> zone you know from provider documentation. Calling `tz_localize("UTC")` on data that is actually
> New-York wall-clock is the off-by-4-hours bug, and it is silent.

### 2.3 The naive-tz join hazard (why "it worked locally" is a trap)

pandas refuses to *mix* aware and naive in some operations and silently mis-joins in others. Two failure
modes:

1. **The `ValueError` (the lucky case — it crashes).** Concatenating/combining aware + naive raises.
   From the pandas docs: *"a mix of timezone-aware and timezone-naive inputs will raise a `ValueError`
   unless `utc=True` is passed to `to_datetime` or `tz='UTC'`"* — i.e. you must normalize first.
   `to_datetime(..., utc=True)` *"localiz[es] timezone-naive inputs as UTC and convert[s] timezone-aware
   inputs to UTC"* (<https://pandas.pydata.org/docs/dev/reference/api/pandas.to_datetime.html>). A crash
   is *good*: it surfaces the bug at ingest.

2. **The silent mis-pair (the dangerous case).** If both frames are *naive* but on *different* clocks
   (Provider A naive-NY, Provider B naive-UTC), no error fires — pandas treats the integers as
   comparable and joins/merges rows that are genuinely 4–5 hours apart. There is no exception, no
   warning, just wrong numbers. **This is why naive datetimes are banned from the warehouse entirely.**

> **Enforce it at the type boundary.** In the TET `transform_data`, assert tz-awareness before persist:
> ```python
> assert df["ts_utc"].dt.tz is not None, "naive datetime reached persist — H1 timezone hazard"
> assert str(df["ts_utc"].dt.tz) == "UTC", "non-UTC tz reached persist — convert at ingest"
> ```
> The cost of a `tz_localize`-then-`tz_convert` per ingest is microseconds; the cost of one naive frame
> reaching the join layer is a backtest you cannot trust.

### 2.4 DST: ambiguous and nonexistent times (the twice-a-year landmine)

DST creates two pathologies that `tz_localize` must be told how to resolve. From
`Series.dt.tz_localize` (<https://pandas.pydata.org/docs/reference/api/pandas.Series.dt.tz_localize.html>):

**`ambiguous=` — the fall-back duplicate hour** (clocks go back; `01:30` happens twice):

| value | behavior (verbatim) |
|---|---|
| `'raise'` *(default)* | "will raise a ValueError if there are ambiguous times" |
| `'infer'` | "will attempt to infer fall dst-transition hours based on order" |
| `'NaT'` | "will return NaT where there are ambiguous times" |
| `bool` array | "True signifies a DST time, False signifies a non-DST time" |

**`nonexistent=` — the spring-forward gap** (clocks jump forward; `02:30` never exists):

| value | behavior (verbatim) |
|---|---|
| `'raise'` *(default)* | "will raise a ValueError if there are nonexistent times" |
| `'shift_forward'` | "will shift the nonexistent time forward to the closest existing time" |
| `'shift_backward'` | "will shift the nonexistent time backward to the closest existing time" |
| `'NaT'` | "will return NaT where there are nonexistent times" |
| `timedelta` | "timedelta objects will shift nonexistent times by the timedelta" |

```python
# spring-forward example (Europe/Warsaw 2015-03-29 02:30 does not exist):
s = pd.to_datetime(pd.Series(["2015-03-29 02:30:00", "2015-03-29 03:30:00"]))
s.dt.tz_localize("Europe/Warsaw", nonexistent="shift_forward")
# 02:30 → 03:00 (the closest existing instant)
```

**Decision for the warehouse:**

- For **market data**, ambiguity essentially never occurs in practice *if you localize the exchange's
  own session timestamps* (exchanges don't trade during the missing spring hour, and the fall duplicate
  hour is disambiguated by the exchange's own sequence). But a *defensive* ingest should still pass
  `ambiguous="infer", nonexistent="shift_forward"` rather than the default `'raise'`, so one stray
  off-session row does not blow up an entire batch.
- The cleanest defense is **avoid local-naive entirely**: prefer providers/feeds that give epoch or
  offset-bearing timestamps (Shapes B/C above), which have *no DST ambiguity by construction*. Reserve
  `tz_localize` for the EOD feeds that force it.
- **Crypto (24/7, no DST)** lives natively in UTC — `exchange_tz='UTC'`, no localize step, no DST logic.
  Treating a crypto series as if it had a NYSE-style local session is its own bug.

---

## 3. Move 2 — Trading calendars and business-day grids

Once time is on a clean UTC axis with a known `exchange_tz`, you must reconcile *which days/sessions
exist*. Markets do not trade on weekends, holidays, or for full hours on half-days; macro series publish
monthly/quarterly with their own release calendars. Modeling the calendar is what stops Move 3 from
inventing data.

### 3.1 The two layers pandas gives you, and the one it doesn't

pandas ships the **machinery** to *define* a calendar but **not the actual exchange calendars**. The
`pandas-market-calendars` docs say exactly this: *"While Pandas includes functionality for custom
holiday calendars, it does not include the actual holiday calendars for specific exchanges … The
`pandas_market_calendars` package fills that role with the holiday, late open and early close calendars
for specific exchanges"* (<https://pandas-market-calendars.readthedocs.io/en/latest/usage.html>).

| Layer | Tool | Use it for |
|---|---|---|
| **Generic business-day grid** | `CustomBusinessDay` / `bdate_range(freq='C', ...)` | A *custom* weekmask + a *known* holiday list (e.g. a market you maintain yourself, or a non-exchange calendar). |
| **Real exchange schedule** | `pandas_market_calendars` (`get_calendar('NYSE')`) | NYSE/LSE/CME/etc. holidays, early closes, *and intraday open/close times in the exchange's tz*. **Use this for any real exchange — do not hand-maintain holiday lists.** |

### 3.2 `CustomBusinessDay` — the generic grid

A `CustomBusinessDay` (alias `CDay`) is a `DateOffset` that *"can be used to create customized business
day calendars which account for local holidays and local weekend conventions"*
(<https://pandas.pydata.org/docs/user_guide/timeseries.html>). Two knobs:

- **`weekmask`** (default `'Mon Tue Wed Thu Fri'`) — which weekdays are business days. Passed straight
  to `numpy.busdaycalendar`. Some markets run Sun–Thu (e.g. parts of the Middle East).
- **`holidays`** — a list/array of dates to exclude. Also passed to `numpy.busdaycalendar`. Accepts
  `str`, `datetime.datetime`, and `np.datetime64`.

```python
import datetime, numpy as np, pandas as pd

# Non-standard weekend (Friday–Saturday weekend → business week Sun..Thu):
weekmask_egypt = "Sun Mon Tue Wed Thu"
holidays = ["2012-05-01", datetime.datetime(2013, 5, 1), np.datetime64("2014-05-01")]
bday_egypt = pd.offsets.CustomBusinessDay(holidays=holidays, weekmask=weekmask_egypt)

dt = datetime.datetime(2013, 4, 30)
dt + 2 * bday_egypt          # Timestamp('2013-05-05 00:00:00')  — skips Fri/Sat + May-1 holiday

# Using a built-in holiday calendar (US federal):
from pandas.tseries.holiday import USFederalHolidayCalendar
bday_us = pd.offsets.CustomBusinessDay(calendar=USFederalHolidayCalendar())
datetime.datetime(2014, 1, 17) + bday_us   # → 2014-01-21 (skips MLK Monday)

# Generate a grid directly with bdate_range, freq='C' (custom):
weekmask = "Mon Wed Fri"
holidays = [datetime.datetime(2011, 1, 5), datetime.datetime(2011, 3, 14)]
pd.bdate_range("2011-01-01", "2011-12-31", freq="C",
               weekmask=weekmask, holidays=holidays)
# DatetimeIndex(['2011-01-03', '2011-01-07', '2011-01-10', ...], freq='C')
```

(All blocks verbatim/adapted from the pandas user guide,
<https://pandas.pydata.org/docs/user_guide/timeseries.html>, and
<https://pandas.pydata.org/docs/reference/api/pandas.tseries.offsets.CustomBusinessDay.html>.)

> **`'B'` vs `'C'`.** `freq='B'` (`BusinessDay`) is Mon–Fri with **no holidays** — it is a *naive*
> business-day grid and will still include Christmas. `freq='C'` (`CustomBusinessDay`) is the one that
> honors `holidays`/`weekmask`. **Never align a real market series to `'B'`** — it invents a trading day
> on every public holiday.

### 3.3 `pandas_market_calendars` — the real exchange schedule

For any *real* exchange, do not hand-maintain holiday lists (you will miss an ad-hoc closure or a
half-day and never know). Use `pandas_market_calendars`
(<https://pandas-market-calendars.readthedocs.io/en/latest/usage.html>):

```python
import pandas_market_calendars as mcal

nyse = mcal.get_calendar("NYSE")          # also: 'LSE', 'CME_Equity', 'CME_Agriculture', 'XKRX', ...

# The exchange's own tz — store this as series metadata `exchange_tz`:
nyse.tz.zone                               # 'America/New_York'

# Sessions in a window, WITH intraday open/close (UTC timestamps):
sched = nyse.schedule(start_date="2016-12-30", end_date="2017-01-10")
# DataFrame indexed by session DATE, columns: market_open, market_close (UTC TIMESTAMPTZ)

# Just the valid trading DATES (no intraday) — the EOD session grid:
valid = nyse.valid_days(start_date="2016-12-20", end_date="2017-01-10")

# Half-days (early closes) within a schedule:
nyse.early_closes(schedule=sched)

# Intraday timestamps at a frequency, clipped to market hours:
mcal.date_range(sched, frequency="1H")

# Intersect two exchanges' calendars (e.g. for a cross-listing or a pair):
mcal.merge_schedules([sched_nyse, sched_lse], how="inner")
```

(Verbatim/adapted from <https://pandas-market-calendars.readthedocs.io/en/latest/usage.html>.)

**Why `schedule()` returns UTC and why that's correct.** `market_open`/`market_close` come back as
UTC `TIMESTAMPTZ` — the *instant* the session opened/closed. That is exactly the right grain to bucket
intraday data against (Move 3), and it correctly encodes early-close days (a 13:00-ET half-day shows a
`market_close` 3.5 hours earlier than a normal day). You keep `exchange_tz` separately so you can derive
the *session date* for the EOD key.

### 3.4 Aligning a series to a market calendar (gaps, weekends, the right way)

The two operations you'll perform constantly:

```python
import pandas_market_calendars as mcal
import pandas as pd

nyse = mcal.get_calendar("NYSE")

# (1) BUILD the canonical EOD session grid for a symbol's history:
session_grid = nyse.valid_days(start_date="2010-01-01", end_date="2024-12-31")
# A DatetimeIndex of REAL trading sessions only — no weekends, no holidays, half-days included.

# (2) ALIGN a daily series onto that grid (relabel, expose gaps as NaN — see Move 3 on reindex):
daily = (
    raw_daily
      .set_index("session_date")
      .reindex(session_grid.tz_convert("America/New_York").normalize())  # exact session set
)
# Missing sessions are now NaN ROWS THAT SHOULD EXIST (a real gap = a halt / no-print day),
# NOT phantom weekend rows. You decide per-series whether to ffill, drop, or flag.
```

> **The gap taxonomy (decide per series, never globally):**
> - **Weekend / holiday** → the session *does not exist*; it should be **absent** from the grid, not
>   filled. `reindex` to the calendar (not `freq='D'`) makes it absent automatically.
> - **Halt / no-trade on a real session** → the session *exists* but has no print; this is a legitimate
>   `NaN` on the grid. For a *price level* series, `ffill` (last close) is defensible and labeled; for a
>   *flow* series (volume) the honest fill is `0`, not `ffill`.
> - **Provider outage** → the data was *available but we failed to fetch it*; this is an **ingest
>   failure**, must be retried, and must NEVER be silently `ffill`-ed to "look complete" (violates the
>   project's "never invent a finance number" non-negotiable).
>
> Conflating these three is H2. The calendar is what lets you tell them apart: if the date is on the
> calendar and missing, it's gap or outage; if it's not on the calendar, it never existed.

---

## 4. Move 3 — Frequency / periodicity: `resample` vs `reindex` vs `asfreq`

This is the move where the right function is non-obvious and the wrong one fails silently. Three
operations, three *different* jobs. **Choosing among them is the whole skill.**

### 4.1 The one-line distinction

| Operation | What it does | Aggregates? | Use when |
|---|---|---|---|
| **`resample(rule).agg()`** | **Changes the frequency by grouping** time into buckets, then **reduces** each bucket. "A time-based groupby, followed by a reduction." | **YES** | Going to a *coarser* grain that requires combining many rows → one (tick → 1-min OHLC; daily → monthly mean). **The only correct tool for downsampling.** |
| **`asfreq(freq)`** | **Relabels** onto a regular target frequency by **selecting** existing rows at the new tick marks; missing ticks become `NaN`. **No aggregation.** | **NO** | Converting an *already-regular* series to a *different regular* frequency where each output tick maps to at most one input row (e.g. enforce a strict `BDay` grid on an already-daily series). |
| **`reindex(new_index)`** | **Relabels** onto **any** target index (need not be regular). Existing labels keep their values; new labels get `NaN` (or a fill). **No aggregation.** | **NO** | Aligning onto an *irregular* target — most importantly **a trading-calendar session grid** (Move 2). `asfreq` is "a thin wrapper around `reindex`" for the *regular* case. |

The pandas user guide states the relationships explicitly:

- `resample()` *"is a time-based groupby, followed by a reduction method on each of its groups"*
  (<https://pandas.pydata.org/docs/user_guide/timeseries.html>).
- `asfreq()` *"is basically just a thin, but convenient wrapper around `reindex()` which generates a
  `date_range` and calls `reindex`"* (same page). → so `asfreq` = `reindex` onto a *regular* grid.

### 4.2 `resample` — downsampling, OHLC, and the aggregation trap

```python
import numpy as np, pandas as pd

rng = pd.date_range("2012-01-01", periods=100, freq="s")
ts = pd.Series(np.random.randint(0, 500, len(rng)), index=rng)

ts.resample("5min").sum()      # flow aggregation (e.g. volume): SUM is correct
ts.resample("5min").mean()     # average
ts.resample("5min").max()      # extremum

# OHLC in one call — the canonical bar-building primitive:
ts.resample("5min").ohlc()
#                      open  high  low  close
# 2012-01-01 00:00:00   308   460    9    205
```

(Blocks verbatim from <https://pandas.pydata.org/docs/user_guide/timeseries.html>.)

**The flow-vs-level trap (the silent `resample` bug).** The *aggregation function must match the
semantics of the column*:

| Column kind | Correct downsample agg | Wrong agg (silent corruption) |
|---|---|---|
| **Price (a level)** | `.ohlc()`, or `.last()` for close-only | `.sum()` → sums prices into nonsense |
| **Volume / shares (a flow)** | `.sum()` | `.mean()` / `.last()` → undercounts traded volume |
| **Return (additive in log)** | `.sum()` on *log* returns | `.sum()` on *simple* returns is wrong (returns compound, not add) |
| **VWAP / weighted** | recompute `sum(px*vol)/sum(vol)` | `.mean()` of price ignores volume weighting |

Building an OHLCV bar therefore needs *different* aggs per column in one pass:

```python
bars = ticks.resample("1min").agg(
    open=("price", "first"),
    high=("price", "max"),
    low=("price", "min"),
    close=("price", "last"),
    volume=("size", "sum"),          # FLOW → sum
    vwap=("notional", lambda x: x.sum() / ticks.loc[x.index, "size"].sum()),
)
```

**Bucket-edge semantics — `closed` and `label` (the off-by-one-bucket trap).** From the user guide:
the default for `label` and `closed` is **`'left'`** for most offsets, **except** `'ME','YE','QE',
'BME','BYE','BQE','W'` which default to **`'right'`**
(<https://pandas.pydata.org/docs/user_guide/timeseries.html>):

```python
ts.resample("5min", closed="right").mean()   # interval (t-5, t]  — right-closed
ts.resample("5min", closed="left").mean()    # interval [t, t+5)  — left-closed (default)
ts.resample("5min", label="left").mean()     # stamp the bucket with its LEFT edge (default)
```

> **Why it matters for finance:** whether a `09:30:00` print lands in the `09:30` bar or the `09:29`
> bar depends on `closed`. Two providers building "1-min bars" with different `closed`/`label`
> conventions produce bars that *look* the same and are off by one minute — a classic cross-provider
> reconciliation failure. **Normalize the bucket convention in the standard model** (pick `closed='left',
> label='left'` and document it), and re-bucket any provider that disagrees from its own raw ticks
> rather than trusting its pre-built bars.

### 4.3 `asfreq` — relabel a regular series, no aggregation

```python
dr = pd.date_range("2010-01-01", periods=3, freq=3 * pd.offsets.BDay())
ts = pd.Series([1.494522, -0.778425, -0.253355], index=dr)
# 2010-01-01, 2010-01-06, 2010-01-11

ts.asfreq(pd.offsets.BDay())          # densify to EVERY business day; gaps → NaN
# 2010-01-01    1.494522
# 2010-01-04         NaN     ← new tick, no source row → NaN
# 2010-01-05         NaN
# 2010-01-06   -0.778425
# ...

ts.asfreq(pd.offsets.BDay(), method="pad")   # forward-fill the gaps at relabel time
# 2010-01-04    1.494522     ← carried from 2010-01-01
```

(Verbatim from <https://pandas.pydata.org/docs/user_guide/timeseries.html>.)

`asfreq` **selects**, it does not aggregate: if the new frequency is *coarser* than the data, `asfreq`
keeps only the rows that fall exactly on the new tick marks and **silently drops everything else**. This
is the trap — `asfreq('D')` on tick data does not "make it daily", it throws away all but one tick per
day. **Coarsening always means `resample`.**

### 4.4 `reindex` — align onto an arbitrary (calendar) index

`reindex` is the general case `asfreq` wraps. Its power is that the target index can be **irregular** —
which is exactly a trading-calendar session grid (Move 2):

```python
import pandas_market_calendars as mcal
nyse = mcal.get_calendar("NYSE")
sessions = nyse.valid_days("2024-01-01", "2024-12-31")   # IRREGULAR (holidays removed)

aligned = daily_close.reindex(sessions)   # exact trading-day set; non-sessions never appear
# Optional, semantically-justified fill:
aligned = daily_close.reindex(sessions).ffill()   # carry last close across a no-print session
```

> **`reindex(calendar)` vs `asfreq('D')` — the canonical wrong-vs-right pair.** `asfreq('D')` produces
> a row for **every** calendar day including weekends/holidays, then forces you to `ffill` Friday across
> Saturday/Sunday — manufacturing two phantom "trading days" per week. `reindex(sessions)` produces a
> row **only** for real sessions. *For any market series, reindex to a calendar; never `asfreq('D')`.*
> This is H2 defeated at the function-call level.

### 4.5 Making periodicity part of the standard model (not an afterthought)

The project's standard model must carry **frequency as a first-class field**, because two series at
different frequencies cannot be joined correctly without it being explicit. Minimum metadata per series:

```python
# Pydantic v2 (the data-plane standard-model style) — illustrative:
from enum import Enum
from pydantic import BaseModel

class Frequency(str, Enum):
    TICK = "tick"; SEC = "1s"; MIN = "1min"; HOUR = "1h"
    DAILY = "1d"; WEEKLY = "1w"; MONTHLY = "1mo"; QUARTERLY = "1q"; ANNUAL = "1y"

class SeriesMeta(BaseModel):
    frequency: Frequency           # the canonical periodicity of stored rows
    bucket_closed: str = "left"    # 'left' | 'right' — the resample convention used to build bars
    bucket_label: str = "left"     # 'left' | 'right' — which edge labels the bucket
    exchange_tz: str               # 'America/New_York' | 'UTC' | ...
    calendar: str | None = None    # 'NYSE' | 'CME_Equity' | None (for macro/none)
    point_in_time: bool            # True if rows carry a knowable-as-of date (see Move 4)
```

Why each field is load-bearing:

- **`frequency`** — a downstream join/aggregation cannot pick `resample` vs `reindex` without it; a
  "monthly" series joined to a "daily" series needs an explicit as-of rule (Move 4), not a naive merge.
- **`bucket_closed`/`bucket_label`** — without these, two providers' "1-min bars" silently disagree
  (§4.2).
- **`exchange_tz`/`calendar`** — required to derive the session grid and to localize for display.
- **`point_in_time`** — the flag that tells the read layer whether `merge_asof` must use the *knowable*
  date, not the *period* date (Move 4 / §6).

> Storing periodicity as metadata is the difference between a warehouse and a pile of CSVs. DataQuery
> exposes frequency as a query parameter precisely because the *same instrument* exists at many
> frequencies and they are not interchangeable (project `00-theory.md`, DataQuery teardown).

---

## 5. Move 4 — Point-in-time as-of alignment with `merge_asof`

Now the payoff. Time is on a UTC axis, calendar-aligned, frequency-tagged. The final move is joining
*across* series — and the only correct tool for irregular/multi-rate financial joins is
**`pandas.merge_asof`**, the vectorized as-of join.

### 5.1 What `merge_asof` is

From the API reference (<https://pandas.pydata.org/docs/reference/api/pandas.merge_asof.html>): it is
*"similar to a left-join except that we match on nearest key rather than equal keys."* The default
behavior — `direction='backward'` — *"selects the last row in the right DataFrame whose 'on' key is less
than or equal to the left's key."* That sentence is the entire point-in-time discipline: each left row
sees only right-side information **at or before** its own timestamp.

**Full signature** (verbatim from the API reference):

```python
pandas.merge_asof(
    left, right,
    on=None, left_on=None, right_on=None,
    left_index=False, right_index=False,
    by=None, left_by=None, right_by=None,
    suffixes=('_x', '_y'),
    tolerance=None,
    allow_exact_matches=True,
    direction='backward',
)
```

| Parameter | Meaning (from the reference) |
|---|---|
| `on` / `left_on`/`right_on` | The key to as-of join on. **Must be numeric (datetimelike/int/float) and in ASCENDING order.** |
| `by` / `left_by`/`right_by` | "Match on these columns before performing merge" — the **exact-match grouping key** (e.g. `ticker`/`figi`). Not required to be sorted. |
| `tolerance` | "Select asof tolerance within this range" — int or `Timedelta`; matches beyond it become `NaN`. |
| `allow_exact_matches` | `True` (default): match `<=` / `>=`. `False`: strict `<` / `>` (exclude the exact-time row). |
| `direction` | `'backward'` (≤, default), `'forward'` (≥), `'nearest'` (closest by abs distance). |

### 5.2 The directions — and why finance is almost always `'backward'`

From the reference:

- **`'backward'`** *(default)* — "the last row whose 'on' key is **less than or equal to** the left's
  key." → "use the most recent information that existed at or before this moment." **This is
  point-in-time. It is the default for a reason.**
- **`'forward'`** — "the first row whose 'on' key is **greater than or equal to**." → looks into the
  *future*. In a backtest context this is **look-ahead bias by construction** — only ever correct for
  forward-looking constructs you explicitly intend (e.g. "next dividend date").
- **`'nearest'`** — "closest in absolute distance." → can pull from the future. **Never use `'nearest'`
  for backtest feature construction** — it silently leaks.

> **Rule:** for any join that feeds a model/backtest, `direction='backward'` (the default) and a
> sensible `tolerance`. `'forward'`/`'nearest'` are reserved for clearly-labeled non-causal lookups and
> must never touch a feature matrix.

### 5.3 The canonical multi-key financial example (quotes ↔ trades)

This is the textbook use: match each trade to the prevailing quote, per ticker. Verbatim from the
pandas reference (<https://pandas.pydata.org/docs/reference/api/pandas.merge_asof.html>):

```python
quotes = pd.DataFrame({
    "time": pd.to_datetime([
        "2016-05-25 13:30:00.023", "2016-05-25 13:30:00.023",
        "2016-05-25 13:30:00.030", "2016-05-25 13:30:00.041",
        "2016-05-25 13:30:00.048", "2016-05-25 13:30:00.049",
        "2016-05-25 13:30:00.072", "2016-05-25 13:30:00.075"]),
    "ticker": ["GOOG","MSFT","MSFT","MSFT","GOOG","AAPL","GOOG","MSFT"],
    "bid": [720.50,51.95,51.97,51.99,720.50,97.99,720.50,52.01],
    "ask": [720.93,51.96,51.98,52.00,720.93,98.01,720.88,52.03],
})
trades = pd.DataFrame({
    "time": pd.to_datetime([
        "2016-05-25 13:30:00.023","2016-05-25 13:30:00.038",
        "2016-05-25 13:30:00.048","2016-05-25 13:30:00.048",
        "2016-05-25 13:30:00.048"]),
    "ticker": ["MSFT","MSFT","GOOG","GOOG","AAPL"],
    "price": [51.95,51.95,720.77,720.92,98.0],
    "quantity": [75,155,100,100,100],
})

pd.merge_asof(trades, quotes, on="time", by="ticker")
#                      time ticker   price  quantity     bid     ask
# 0 2016-05-25 13:30:00.023   MSFT   51.95        75   51.95   51.96
# 1 2016-05-25 13:30:00.038   MSFT   51.95       155   51.97   51.98
# 2 2016-05-25 13:30:00.048   GOOG  720.77       100  720.50  720.93
# 3 2016-05-25 13:30:00.048   GOOG  720.92       100  720.50  720.93
# 4 2016-05-25 13:30:00.048   AAPL   98.00       100     NaN     NaN   ← no prior AAPL quote → NaN
```

Read the result: each trade got the **last quote for the *same* ticker at or before its time**. The
final AAPL row is `NaN` because no AAPL quote existed yet — *correctly*, the join refuses to invent a
quote. With a tolerance (verbatim):

```python
pd.merge_asof(trades, quotes, on="time", by="ticker", tolerance=pd.Timedelta("2ms"))
# row 1 (MSFT @ .038) → bid/ask NaN: the nearest prior MSFT quote (.030) is >2ms away → dropped to NaN

pd.merge_asof(trades, quotes, on="time", by="ticker",
              tolerance=pd.Timedelta("10ms"), allow_exact_matches=False)
# strict '<': a trade at the SAME instant as a quote no longer matches that quote
```

> **`tolerance` is a staleness guard.** Without it, a trade at 16:00 matches a quote from 09:30 if that
> was the last one — pairing a live trade with a 6.5-hour-stale quote. `tolerance=pd.Timedelta("1s")`
> says "if the most recent quote is older than 1s, give me `NaN`, not a stale lie." For EOD-vs-
> fundamental joins the tolerance is months; for tick joins it's milliseconds. **Always set it.**

### 5.4 The hard preconditions (violate them → silent wrong answers)

The reference is explicit: the join keys **must be sorted ascending** ("The data MUST be in ascending
order") and **numeric/datetimelike**. Three precondition failures, each silent or near-silent:

1. **Unsorted keys.** `merge_asof` assumes monotonic input. If `on` is not sorted, results are *wrong*
   (it walks a merge cursor, not a hash table). Newer pandas raises on some unsorted inputs, but **do
   not rely on it** — sort defensively:
   ```python
   left  = left.sort_values("time")
   right = right.sort_values("time")
   ```
   Note: with `by`, only the `on` key must be globally sorted; `by` need not be ("It is not required to
   sort by these columns" — the reference). But sorting by `[by, on]` is the safe habit.

2. **Mixed/naive tz on the key.** If `left.time` is UTC-aware and `right.time` is naive (or a different
   zone), the join either raises or — worse, when both are naive on different clocks — *mis-pairs across
   the offset* (H1 again, now inside the join). **This is why Move 1 is a precondition for Move 4.**

3. **Float keys / precision.** As-of on float seconds invites floating-point near-misses at the `<=`
   boundary. Use the integer/datetime64 axis, not floats, for the `on` key.

### 5.5 Why naive `merge` / `concat` silently fails here

This is the crux of the "value normalization" argument:

- **`pd.merge(left, right, on='time')`** is an **equi-join**: it pairs rows with *exactly equal*
  timestamps and **drops every left row with no exact match**. Two real-world series essentially never
  share exact microsecond timestamps, so an equi-join on time **silently discards almost all rows** (or,
  with `how='left'`, fills almost everything `NaN`). You get a frame that *looks* joined and is 99%
  empty.

- **`pd.concat([a, b], axis=1)`** aligns on the **index** by exact label and unions the indices. Two
  series on different irregular timestamps produce a frame full of interleaved rows where each column is
  `NaN` wherever the other had a tick — a sparse, ragged, mostly-`NaN` matrix that then tempts a naive
  `ffill` (which, done blindly, becomes the look-ahead vector — §6).

- **`merge_asof`** is the *only* join that says "for each left timestamp, carry the **last known** right
  value forward." That is the as-of / last-observation-carried semantics every multi-rate financial
  join actually needs, done in one vectorized pass (`O(n+m)` on sorted input), not a Python loop.

> **One-line test for whether you need `merge_asof`:** *"do the two series tick at the same instants?"*
> If no (different frequencies, irregular, multi-provider), an equi-join is wrong and `merge_asof` is
> right. The answer is almost always "no" in finance.

---

## 6. Look-ahead and survivorship bias — the thing as-of joins prevent

`merge_asof(direction='backward')` is not a convenience — it is the **mechanical guarantee against
look-ahead bias**. Define the biases (cited) and show how time-normalization defeats each.

### 6.1 Look-ahead bias

*"Look-ahead bias refers to the unintentional use of data or information that would not have been
available at the time during backtesting"* — "the most fundamental backtesting error, and also one of
the easiest to introduce accidentally"
(<https://corporatefinanceinstitute.com/resources/career-map/sell-side/capital-markets/look-ahead-bias/>;
corroborated <https://bookdown.org/palomar/portfoliooptimizationbook/8.2-seven-sins.html> — the "seven
sins of quantitative investing"). Three concrete leak vectors and the time-normalization fix:

| Leak vector | The mistake | The fix in this doc |
|---|---|---|
| **Future row in a join** | `direction='forward'`/`'nearest'`, or an equi-join that happens to pull the next bar. | `direction='backward'` (default) + `tolerance`. §5.2 |
| **Restatement / revision** | Joining a fundamental by *period-end* date, so a value later *revised* is used at its revised value on the original date. | Carry both `period_end` and `knowable_at`; as-of on **`knowable_at`**. §6.3 |
| **Blind `ffill`** | `ffill` across a calendar boundary fills the *current* day with a value that, semantically, belongs to a *future* publication. | `ffill` only *after* a backward as-of on the knowable date; never `ffill` a not-yet-published value into the past. §4.4 |

### 6.2 Survivorship bias

*"Survivorship bias means testing your strategy only on assets that exist today, ignoring those that
were delisted, went bankrupt, or were acquired"* — it can *"inflate annual returns by 1–4%"* with a
compounding effect (<https://www.quantifiedstrategies.com/survivorship-bias-in-backtesting/>). The fix
is **point-in-time data that includes the failures**
(<https://sharpely.in/blog/bias-free-backtesting-explained...>). In *time* terms, this is two
requirements on the security-master / calendar layer (cross-references the security-master theory):

1. **Keep delisted rows.** A symbol's series must not be truncated when it delists; the *delist date* is
   a real session boundary, and the rows up to it must survive in the warehouse with the symbol's
   identity preserved (project `00-theory.md`, security master = bitemporal).
2. **Reconstruct the universe as-of.** "Which symbols were in the S&P 500 on 2015-06-30?" must return
   the *then-current* membership (including names since deleted) — itself a `merge_asof`/bitemporal
   lookup on the membership table by `knowable_at`, never `SELECT * FROM current_members`.

As-of joins prevent look-ahead; **point-in-time *storage* (delisted rows retained, membership versioned)
prevents survivorship.** They are complementary: the join is the read-side guard, the storage is the
write-side guard.

### 6.3 Fiscal-calendar irregularity for fundamentals (the worst-case as-of)

Fundamentals are where time-normalization is most dangerous, because **the date on the data is not the
date you may use it.** Three distinct dates, never to be conflated:

| Date | Meaning | Example |
|---|---|---|
| **Period-end / `period_of_report`** | The fiscal period the number describes. | FY2023 Q1 ending 2023-03-31. |
| **Filing / `knowable_at`** | When the number became **public** (the SEC filing accepted date). | The 10-Q filed 2023-05-04. |
| **Restatement / amendment** | When a *revised* value superseded the original (10-K/A, restatement). | An 8-K/amended filing 2023-09-12. |

Two further irregularities compound it:

- **Fiscal ≠ calendar year.** "A fiscal year is any consecutive 12-month period ending on the last day
  of any month other than December" (<https://www.irs.gov/businesses/small-businesses-self-employed/tax-years>);
  filings are due months after period-end ("tax returns are due on the fourth month following the
  conclusion of the determined fiscal year end"). So Company A's "Q1" (Mar) and Company B's "Q1" (Sep,
  fiscal-year-ending-June) describe *different calendar windows* — you cannot align fundamentals by
  "quarter label", only by explicit `period_end` + `knowable_at`.
- **Reporting lag is the leak.** Earnings for the period ending 2023-03-31 were not knowable until the
  ~2023-05-04 filing. A model that uses Q1 fundamentals on 2023-03-31 is using information from the
  future — the canonical look-ahead bug. SEC EDGAR is the GREEN, public-domain source that carries
  **both** dates: `period` (period of report) and `filed` (filing date) on every submission
  (project `02-skills-and-pipeline.md`, GREEN provider set; EDGAR is public domain).

**The correct as-of join for fundamentals** — backward on `knowable_at`, never `period_end`:

```python
# prices: one row per session (UTC/NY session grid); fundamentals: irregular, two dates each.
fundamentals = fundamentals.rename(columns={"filed": "knowable_at"})

# Sort BOTH by the as-of key; group by the canonical instrument id (figi from the security master):
prices       = prices.sort_values("ts_utc")
fundamentals = fundamentals.sort_values("knowable_at")

pit = pd.merge_asof(
    prices,
    fundamentals,
    left_on="ts_utc",
    right_on="knowable_at",      # ← the FILING date, the moment the number became public
    by="figi",                   # canonical id from the security master (NOT a reused ticker)
    direction="backward",        # only fundamentals KNOWABLE at-or-before this price bar
    tolerance=pd.Timedelta("400D"),  # don't carry a stale annual past its next expected report
)
# Each price bar now carries the most recent fundamental THAT WAS PUBLIC at that bar's time.
# Joining on `period_end` instead of `knowable_at` would inject ~1–2 months of future knowledge.
```

> **The single sentence that defines correctness here:** *as-of on the date the number became knowable,
> never the date the number is about.* Conflating `period_end` and `knowable_at` is the most expensive
> mistake in this entire document, because it produces a backtest that is beautiful and a live strategy
> that is broken.

---

## 7. The end-to-end recipe (all four moves, in order)

Putting Moves 1→4 together as the write-path normalization pass (`transform_data` in the TET fetcher),
plus the read-path join:

```python
import pandas as pd
import pandas_market_calendars as mcal

# ── WRITE PATH (inside transform_data; runs on the worker, off the request path) ────────────────

def normalize_time(df: pd.DataFrame, *, source_zone: str, calendar: str | None,
                   target_freq: str | None) -> pd.DataFrame:
    # MOVE 1 — tz-aware UTC. Branch by provider timestamp shape (see §2.2).
    df["ts_utc"] = (
        pd.to_datetime(df["raw_local"])              # naive local wall-clock case
          .dt.tz_localize(source_zone, ambiguous="infer", nonexistent="shift_forward")
          .dt.tz_convert("UTC")
    )
    assert df["ts_utc"].dt.tz is not None and str(df["ts_utc"].dt.tz) == "UTC"

    # Derive the local session date (the EOD key) — keeps exchange_tz meaning (§2.1).
    if calendar:
        df["session_date"] = df["ts_utc"].dt.tz_convert(source_zone).dt.normalize()

    # MOVE 2 — align to the REAL trading calendar (not freq='D'/'B').
    if calendar:
        cal = mcal.get_calendar(calendar)
        sessions = cal.valid_days(df["session_date"].min(), df["session_date"].max())
        df = (df.set_index("session_date")
                .reindex(sessions.tz_convert(source_zone).normalize()))   # gaps exposed as NaN rows

    # MOVE 3 — frequency. resample to COARSEN (aggregate); reindex/asfreq to RELABEL (no agg).
    if target_freq:                                  # e.g. ticks → 1-min OHLCV
        df = df.resample(target_freq, on="ts_utc").agg(
            open=("price", "first"), high=("price", "max"),
            low=("price", "min"),  close=("price", "last"),
            volume=("size", "sum"),                  # FLOW → sum; LEVEL → first/last
        )
    return df  # → persisted with SeriesMeta{frequency, bucket_closed, exchange_tz, calendar, point_in_time}

# ── READ PATH (the join, served from the store — never re-fetches upstream) ─────────────────────

def as_of_join(prices: pd.DataFrame, signal: pd.DataFrame, *, knowable_col: str,
               id_col: str = "figi", tol: str = "400D") -> pd.DataFrame:
    # MOVE 4 — point-in-time. backward as-of on the KNOWABLE date, grouped by canonical id.
    prices = prices.sort_values("ts_utc")
    signal = signal.sort_values(knowable_col)
    return pd.merge_asof(
        prices, signal,
        left_on="ts_utc", right_on=knowable_col,
        by=id_col, direction="backward",
        tolerance=pd.Timedelta(tol),
    )
```

**Order is not optional:** Move 2 needs Move 1's clean tz + `exchange_tz`; Move 3's calendar-reindex is
Move 2; Move 4 needs Move 1 (tz-matched keys) and Move 3 (a known frequency to choose the as-of
`tolerance`). Run them out of order and each later move silently corrupts on the earlier move's
unfixed hazard.

---

## 8. Decision tables (quick reference)

### 8.1 "I need to change a series' frequency" → which function

| Going from → to | Operation | Function | Note |
|---|---|---|---|
| ticks → 1-min/1-day bars | **coarsen + aggregate** | `resample(rule).agg(...)` / `.ohlc()` | match agg to flow/level (§4.2) |
| daily → monthly mean/last | **coarsen + aggregate** | `resample("ME").mean()`/`.last()` | watch `closed`/`label` default flips |
| irregular → trading-calendar grid | **relabel onto irregular index** | `reindex(sessions)` | the market-data default; **not** `asfreq('D')` |
| regular daily → strict BDay grid | **relabel onto regular grid** | `asfreq(BDay())` | gaps → NaN; `method='pad'` to fill |
| daily → upsampled hourly (no new data) | **relabel finer** | `asfreq("h")` / `resample("h").ffill()` | you are *inventing* ticks — label it |

### 8.2 "I need to join two time series" → which join

| Situation | Join |
|---|---|
| Same exact timestamps, both series | `pd.merge(on='time')` (equi-join) — rare in finance |
| Different/irregular timestamps, want last-known value | **`merge_asof(direction='backward')`** + `by=id` + `tolerance` |
| Need the *next* event (dividend, expiry) | `merge_asof(direction='forward')` — non-causal, label it |
| Fundamentals onto price bars | `merge_asof(backward, left_on=ts, right_on=knowable_at, by=figi)` (§6.3) |
| Align two columns onto a shared calendar index first | `reindex(sessions)` each, then operate column-wise |

### 8.3 "Which timezone op do I call"

| I have… | I want… | Call |
|---|---|---|
| naive wall-clock, known zone | tag it (no clock move) | `tz_localize(zone, ambiguous=..., nonexistent=...)` |
| aware datetime | move to another zone (same instant) | `tz_convert("UTC")` |
| epoch int | UTC aware | `to_datetime(x, unit=..., utc=True)` (**never** `tz_localize`) |
| offset-bearing string | UTC aware | `to_datetime(x, utc=True)` (**never** `tz_localize`) |
| mixed aware+naive list | one UTC axis | `to_datetime(x, utc=True)` (localizes naive as UTC, converts aware) |

---

## 9. Anti-patterns (mistake → fix), inline-cited

| # | Anti-pattern | Why it breaks | Fix |
|---|---|---|---|
| A1 | Storing **naive** datetimes in the warehouse | Two naive-different-zone series mis-pair with no error (H1, §2.3) | Every `ts` is `datetime64[us, UTC]`; assert at persist |
| A2 | `tz_localize("UTC")` on data that's actually local wall-clock | Mis-tags the instant; off by the UTC offset, silent | `tz_localize(true_source_zone).tz_convert("UTC")` (§2.2) |
| A3 | `tz_localize` on an epoch int or offset string | Epoch/offset are already UTC/aware; double-applies a zone | `to_datetime(..., utc=True)` (§2.2) |
| A4 | `ambiguous='raise'`/`nonexistent='raise'` (defaults) on a batch with one off-session row | One stray DST row aborts the whole ingest | `ambiguous='infer', nonexistent='shift_forward'` (§2.4) |
| A5 | Aligning a market series with `asfreq('D')` or `freq='B'` | Invents weekend/holiday "trading days"; `'B'` ignores holidays (§3.2, §4.4) | `reindex(calendar.valid_days(...))` (`pandas_market_calendars`) |
| A6 | `ffill` across weekends/halts blindly | Carries a level into sessions that never traded; for *flows* it double-counts | Fill only on real sessions; `0` for flows; flag outages, never `ffill` them (§3.4) |
| A7 | `asfreq('D')` to "make tick data daily" | `asfreq` **selects**, doesn't aggregate — drops all but one tick/day (§4.3) | `resample('1d').ohlc()`/`.agg()` |
| A8 | `resample().sum()` on a price level / `.mean()` on volume | Flow/level mismatch silently corrupts the bar (§4.2) | per-column agg: `first/max/min/last` for price, `sum` for volume |
| A9 | Trusting two providers' pre-built "1-min bars" as identical | Different `closed`/`label` conventions → off-by-one-bucket (§4.2) | Re-bucket from raw ticks with one documented convention |
| A10 | `pd.merge(on='time')` across irregular series | Equi-join drops ~all rows (no exact match) (§5.5) | `merge_asof(direction='backward')` |
| A11 | `merge_asof` on unsorted / float / tz-mixed keys | Walks a cursor on bad input → wrong matches, silent (§5.4) | sort ascending; datetime64-UTC key; `by` for the id |
| A12 | `merge_asof(direction='nearest'/'forward')` into a feature matrix | Pulls future values → look-ahead bias by construction (§5.2, §6.1) | `direction='backward'` for any causal feature |
| A13 | as-of joining fundamentals on **`period_end`** | Uses the number weeks before it was public → the worst look-ahead (§6.3) | join on **`knowable_at`** (filing date) |
| A14 | Truncating a symbol's series when it delists / `SELECT current_members` | Survivorship bias; 1–4% inflated returns (§6.2) | keep delisted rows; reconstruct universe as-of |
| A15 | Assuming `datetime64[ns]` post-pandas-3.0 | New default is `[us]`; epoch-int conversions are 1000× off (§0) | pin the unit explicitly when epoch is load-bearing |

---

## 10. What to read next (cross-references)

- **Schema/field normalization (value normalization #1)** — the `__alias_dict__` / field-intersection
  standard-model pattern that precedes this doc (which *series* a row is). This doc handles *when* it is.
- **Security-master / symbology theory** — supplies the canonical `figi` id that the `by=` key in every
  `merge_asof` must use (a reused ticker is itself a point-in-time hazard: tickers get recycled across
  different companies over time).
- **The TimescaleDB store skill** (`timescaledb-timeseries`) — the SQL-layer mirror of this doc:
  `time_bucket` (= `resample`), `time_bucket_gapfill`+`locf`/`interpolate` (= calendar-aware fill, §3.4),
  continuous aggregates (= materialized `resample`). The same four hazards exist at the SQL layer; that
  skill enforces "never fabricate a price" in `gapfill.sql` terms.
- **Project `00-theory.md`** — primitive #1 (Normalize), the write-path-only-fetches rule (this doc's
  Move 4 join runs on the *read* path, served from the store, never re-hitting upstream), and the
  `commercialOk`/provenance stamp every normalized series still carries.

---

## Appendix — primary-source citation index

| Claim in this doc | Source |
|---|---|
| `merge_asof` full signature, directions, by/tolerance/allow_exact_matches, quotes↔trades example | <https://pandas.pydata.org/docs/reference/api/pandas.merge_asof.html> |
| `tz_localize` vs `tz_convert`; `resample` = time-groupby+reduce; `asfreq` wraps `reindex`; `ohlc()`; `closed`/`label` defaults; `CustomBusinessDay`; `bdate_range freq='C'` | <https://pandas.pydata.org/docs/user_guide/timeseries.html> |
| `tz_localize` `ambiguous=`/`nonexistent=` option semantics | <https://pandas.pydata.org/docs/reference/api/pandas.Series.dt.tz_localize.html> |
| `CustomBusinessDay` weekmask/holidays/calendar params | <https://pandas.pydata.org/docs/reference/api/pandas.tseries.offsets.CustomBusinessDay.html> |
| pandas-market-calendars `get_calendar`/`schedule`/`valid_days`/`date_range`/`tz`/`early_closes` | <https://pandas-market-calendars.readthedocs.io/en/latest/usage.html> · <https://pypi.org/project/pandas_market_calendars/> |
| `to_datetime(utc=True)` localizes naive as UTC, converts aware; mixed aware/naive raises | <https://pandas.pydata.org/docs/dev/reference/api/pandas.to_datetime.html> |
| pandas 3.0 datetime default unit → microseconds (was ns); released 2026-01-21 | <https://pandas.pydata.org/docs/whatsnew/v3.0.0.html> |
| Normalized market data adopts a single tz (UTC); exchanges publish local | <https://databento.com/microstructure/normalization> |
| Look-ahead bias definition | <https://corporatefinanceinstitute.com/resources/career-map/sell-side/capital-markets/look-ahead-bias/> · <https://bookdown.org/palomar/portfoliooptimizationbook/8.2-seven-sins.html> |
| Survivorship bias (1–4% inflation); point-in-time fixes it | <https://www.quantifiedstrategies.com/survivorship-bias-in-backtesting/> · <https://sharpely.in/blog/bias-free-backtesting-explained...> |
| Fiscal year = any 12-mo period ending non-December; filing due ~4 months after period-end | <https://www.irs.gov/businesses/small-businesses-self-employed/tax-years> |
