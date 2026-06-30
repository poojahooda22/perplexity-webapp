# Theory — Value Normalization: Units, Scale, Currency, and Rate Representation

> **Product line:** JPM-Markets re-engineering **data-analytics** product line (NOT Lumina). New
> Python/FastAPI/data-engineering stack. Greenfield — this is theory + a concrete normalization recipe,
> not yet wired to a codebase `file:line`.
>
> **Scope (row/VALUE normalization #1):** reconciling *numeric conventions* across providers — **units,
> scale factors, currency, and rate/yield representation**. This is the **"correct names, wrong values"**
> failure surface: schema-level normalization (this skill's other refs) has already mapped
> `lastPrice → price` and `vol → volume`, so the *columns line up* — and yet the *numbers are wrong by a
> factor of 100, 1000, 1e9, or a currency*. Field-name reconciliation is necessary but **not sufficient**;
> the value underneath each correctly-named field still carries the provider's private convention.
>
> **The thesis in one sentence:** pick **ONE canonical convention per standard field**, document it,
> convert **every** provider into it inside `transform_data`, and **record the source convention + the
> applied scale factor in provenance** so the conversion is auditable and reversible. A number you cannot
> trace back to "raw value × scale, in currency X, fetched from provider Y" is a number you cannot trust.

---

## 0. Plain-language on-ramp (read this first)

Two market-data vendors both have a field they call `price`. Vendor A says `price = 150.25`. Vendor B
says `price = 15025`. Vendor C says `price = 150250000000`. **All three describe the same $150.25 stock.**

- Vendor A reports in **dollars** as a float.
- Vendor B reports in **cents** as an integer (the smallest currency unit).
- Vendor C reports in **fixed-point nanodollars** — an integer where 1 unit = `1e-9` of a dollar, so
  `$150.25 = 150_250_000_000`. This is exactly what Databento's binary format does
  ([Databento DBN](https://databento.com/docs/standards-and-conventions/databento-binary-encoding):
  "a display price of $1.25 is encoded as an integer value of 1250000000").

If your pipeline maps all three to a field named `price` and then **trusts the number as-is**, your
analytics will show one stock trading at $150.25, another at $15,025, and a third at $150 *billion*. The
column names matched perfectly. The values are off by 100× and 1e9×. **That is the entire problem this
document exists to kill.**

The same failure has three more flavors:

- **Scale factors.** A 10-K reports revenue as `383285` with a label "in millions" — that's
  **$383.285 billion**, not $383,285. Another vendor reports the same figure already expanded to
  `383285000000`. Same company, same fact, 1,000,000× apart.
- **Rate representation.** A bond yield comes back as `0.0452` from one source, `4.52` from another, and
  `452` from a third. Those are **the same yield** expressed as a *decimal*, a *percent*, and *basis
  points*. Read `452` as a percent and you've told the user a 30-year Treasury yields 452% — a silent
  **10,000× error** ([basis points: 1 bp = 0.01% = 0.0001 decimal](https://goodcalculators.com/basis-points-conversion-calculator/)).
- **Currency.** `price = 150.25` — in USD? EUR? JPY? A ¥150 stock and a $150 stock are not "the same
  number." And the moment you convert between them, *which* FX rate you used (and when) becomes a fact you
  must record, or your numbers are unreproducible.

**What we build:** a single canonical convention per field (e.g. *price in the instrument's native
currency as a `Decimal`, scale always absolute, yields as decimal fractions, money never as float*), a
`transform_data` step that converts every provider into it, and a `provenance` block on every value that
records `{source_field, source_convention, scale_applied, currency, fx_rate_used, as_of}`.

**Why it matters to us:** we are re-engineering JPM-Markets-grade data products. A finance product that
displays a wrong number — even once, even off by a clean factor of 100 — is not a product, it's a
liability. The fix is not heroics; it is **discipline at the transform boundary plus provenance**.

---

## 1. The failure surface: "correct names, wrong values"

Schema normalization (the sibling refs) solves *structural* heterogeneity: different field names, nesting,
casing, presence/absence. It produces a record whose **keys** are canonical. This document solves *semantic*
heterogeneity: the **values** under those canonical keys still encode a provider-private convention.

The four axes of value heterogeneity, each its own section below:

| Axis | The hidden variable | The silent error magnitude |
|---|---|---|
| **Units / representation** (§3) | cents vs dollars vs index points; integer-fixed-point vs float | 100× (cents) · 1e9× (nanodollar fixed-point) · float drift (sub-cent) |
| **Scale factor** (§4) | absolute vs thousands vs millions vs billions | 1,000× · 1,000,000× · 1,000,000,000× |
| **Rate / yield representation** (§5) | decimal vs percent vs basis points | 100× (pct↔decimal) · 10,000× (bps↔decimal) |
| **Currency** (§6) | which currency; whether/when FX-converted | unbounded (FX ratio); + reproducibility loss |

The structural reason this is dangerous: **every one of these errors produces a number that still
type-checks and still renders.** `452` is a valid float. `15025` is a valid int. `383285` is a plausible
revenue. Nothing crashes. The wrongness is invisible until a human who knows the instrument looks at the
output and says "that can't be right" — and by then it's in a chart a client is reading.

> **The discipline (stated once, applied everywhere below):**
> 1. **Canonical convention per field** — decide it, write it down, never decide it twice.
> 2. **Convert at the transform boundary** — `transform_data(raw, provider) → canonical`. The convention
>    is provider-specific knowledge; it lives in the per-provider adapter, never leaks downstream.
> 3. **Record the conversion in provenance** — `{source_convention, scale_applied, currency, fx, as_of}`.
>    Provenance makes the conversion **auditable** (was it right?) and **reversible** (recover the raw).
> 4. **Fail closed, never guess** — if you cannot determine a provider's convention for a field, the value
>    is `unavailable`, not a best-guess number. (A wrong number is worse than a missing one in finance.)

---

## 2. The canonical convention table (decide once, here)

Before any code, the contract. Every standard numeric field gets **one** canonical convention. This is the
single source of truth that `transform_data` targets and that consumers may assume. Pin it; changing it
later is a migration, not a tweak.

| Canonical field | Canonical convention | Python type | Rationale |
|---|---|---|---|
| `price`, `open/high/low/close`, `bid`, `ask` | native currency, **absolute** (dollars not cents), exact | `Decimal` | money → never float (§7); cents vs dollars unified to dollars |
| `volume`, `shares_outstanding` | **absolute** count (not thousands/millions) | `int` | counts are exact integers; no fractional shares at this layer |
| `market_cap`, `revenue`, `net_income`, any monetary statement line | native currency, **absolute** | `Decimal` | XBRL/vendors love thousands/millions scale (§4) |
| `yield`, `coupon`, `interest_rate`, `dividend_yield` | **decimal fraction** (`0.0452` = 4.52%) | `Decimal` | one rate convention end-to-end kills the 100×/10,000× bug (§5) |
| `change_pct`, `return`, `weight` | **decimal fraction** (`0.0123` = +1.23%) | `Decimal` | same — never store "1.23" meaning 1.23% |
| `fx_rate` | units of quote ccy per 1 unit of base ccy | `Decimal` | direction is a convention too (§6.4) |
| `currency` | ISO 4217 alpha-3 (`USD`, `JPY`, `EUR`) | `str` | the unit that makes the number meaningful (§6) |
| timestamps | UTC, nanoseconds-since-epoch (or tz-aware UTC `datetime`) | `int`/`datetime` | out of this doc's scope; flagged for completeness |

> **Display ≠ storage.** We store `price` as a `Decimal` in dollars and `yield` as `0.0452`. The
> presentation layer renders `$150.25` and `4.52%`. **Never normalize toward the display string** — round
> only at the edge, store full precision. (§7.4)

---

## 3. Price units and the integer-vs-float precision trade-off

### 3.1 The three price unit families

Databento's normalization guide states the problem precisely:

> "Different markets may report prices in different units (cents, dollars, index points) or currencies.
> Normalized market data usually adopts a more uniform standard on units."
> — [Databento, *Normalization*](https://databento.com/microstructure/normalization)

1. **Dollars (major unit), float or decimal** — `150.25`. Human-readable. Float-encoded by most JSON REST
   APIs (Yahoo, Finnhub, Twelve Data).
2. **Cents (minor unit), integer** — `15025`. Common in payments and some exchange feeds. The integer
   *is* the smallest currency unit; you divide by 100 to get dollars. (Generalizes per currency — §6.3.)
3. **Index points** — for index instruments (S&P 500 = `5432.10`), "points" aren't dollars at all; an index
   level has no currency in the cents sense. Don't blindly multiply an index level by a currency scale.

### 3.2 Fixed-point integers: how exchanges and Databento actually encode price

The professional convention is **not** float and **not** cents — it's a **fixed-point integer with a large
implicit scale**. Databento's binary encoding (DBN) is the canonical example:

> "In DBN, prices are represented as fixed-point integers (`int64_t`), where every unit implicitly
> corresponds to `1e-9`. For example, a display price of $1.25 is encoded as an integer value of
> `1250000000`." — [Databento DBN](https://databento.com/docs/standards-and-conventions/databento-binary-encoding)

The exact constants, read from the DBN Rust source
([databento/dbn `lib.rs`](https://github.com/databento/dbn/blob/main/rust/dbn/src/lib.rs)):

```rust
// github.com/databento/dbn — rust/dbn/src/lib.rs (verbatim)
pub const FIXED_PRICE_SCALE: i64 = 1_000_000_000;  // 1e9 — 1 unit = 1 nanodollar
pub const UNDEF_PRICE: i64       = i64::MAX;         // 9_223_372_036_854_775_807 — "no price"
pub const UNDEF_ORDER_SIZE: u32  = u32::MAX;
pub const UNDEF_TIMESTAMP: u64   = u64::MAX;
```

Two load-bearing facts here, both of which you MUST handle in `transform_data`:

- **The scale is `1e-9`.** To get dollars: `price_dollars = raw_int / FIXED_PRICE_SCALE`
  (`1_250_000_000 / 1_000_000_000 = 1.25`). Forget the divide and you display $1.25 as **$1.25 billion**.
- **`UNDEF_PRICE = i64::MAX = 9223372036854775807` is a SENTINEL, not a price.** A field is set to this
  when the price is absent/unused. If you run the scale divide on it blindly you get
  `9.22e9` dollars — a "$9.2 billion" trade that never happened. **You must detect the sentinel and emit
  `null`/`unavailable`, not a number.** Databento added these constants to the Python package precisely
  "to make it easier to filter null values"
  ([DBN CHANGELOG](https://github.com/databento/dbn/blob/main/CHANGELOG.md)).

### 3.3 Why fixed-point integer beats float for storage — and its cost

Databento states the trade-off directly:

> "Floating-point prices lose precision over exact fixed-decimal integer prices, but may only introduce
> negligible modeling errors while being easier to use with numerical libraries and mathematical routines."
> — [Databento, *Normalization*](https://databento.com/microstructure/normalization)

| | Fixed-point integer (`int64` × 1e-9) | Float (`float64`) |
|---|---|---|
| **Exactness** | Exact — `0.1` is `100_000_000`, no rounding | Inexact — `0.1` is not representable in binary float |
| **Range/precision** | int64 holds ~9.2e18, so prices up to ~$9.2e9 at 1e-9 granularity | 53-bit mantissa: ~15-17 significant decimal digits |
| **Comparison/equality** | Safe (`a == b` on integers) | Unsafe (`0.1 + 0.2 != 0.3`) |
| **Math libraries** | Awkward (must scale in/out) | Native (numpy, pandas, scipy) |
| **Aggregation drift** | None | Accumulates over millions of sums |

**The binary-float landmine (proof, from the Python docs):**

```python
>>> 0.1 + 0.1 + 0.1 - 0.3
5.5511151231257827e-17          # NOT zero — binary float can't represent 0.1 exactly
>>> from decimal import Decimal
>>> Decimal('0.1') + Decimal('0.1') + Decimal('0.1') - Decimal('0.3')
Decimal('0')                    # exact
```
— [Python `decimal` docs](https://docs.python.org/3/library/decimal.html): *"In decimal floating point,
`0.1 + 0.1 + 0.1 - 0.3` is exactly equal to zero."*

**Our canonical choice (§2):** store `price` as **`Decimal` in dollars** (not raw fixed-point int, not
float). `Decimal` gives us exactness *and* readability *and* native arithmetic, at a storage/perf cost we
can afford at this layer (we are not a sub-microsecond matching engine; we are an analytics warehouse).
For the *time-series warehouse* row, the sibling `timescaledb-timeseries` skill may prefer `numeric` or a
scaled `bigint` — but the **canonical in-flight representation in the Python transform is `Decimal`
dollars**.

### 3.4 Reference implementation — price unit normalization

```python
from decimal import Decimal
from enum import Enum
from typing import Optional


class PriceUnit(str, Enum):
    """How a provider encodes price in its raw payload."""
    DOLLARS_FLOAT = "dollars_float"        # 150.25 as a float/str  (Yahoo, Finnhub, Twelve Data)
    CENTS_INT = "cents_int"                # 15025 as int           (some payment/exchange feeds)
    FIXED_POINT_1E9 = "fixed_point_1e9"    # 150250000000 as int    (Databento DBN)
    INDEX_POINTS = "index_points"          # 5432.10 — not a currency amount


# Databento DBN sentinel — github.com/databento/dbn lib.rs: UNDEF_PRICE = i64::MAX
DBN_UNDEF_PRICE = 9_223_372_036_854_775_807
DBN_FIXED_PRICE_SCALE = Decimal(1_000_000_000)  # 1e9


def normalize_price(raw, unit: PriceUnit) -> Optional[Decimal]:
    """Convert a provider's raw price into the canonical convention:
    Decimal, in the major currency unit (dollars), absolute scale, exact.
    Returns None for sentinels / missing — NEVER a fabricated number.
    """
    if raw is None:
        return None

    if unit is PriceUnit.FIXED_POINT_1E9:
        raw_int = int(raw)
        if raw_int == DBN_UNDEF_PRICE:          # <-- the sentinel guard. Non-negotiable.
            return None
        return Decimal(raw_int) / DBN_FIXED_PRICE_SCALE          # 1_250_000_000 -> Decimal('1.25')

    if unit is PriceUnit.CENTS_INT:
        return Decimal(int(raw)) / Decimal(100)                  # 15025 -> Decimal('150.25')

    if unit is PriceUnit.DOLLARS_FLOAT or unit is PriceUnit.INDEX_POINTS:
        # CRITICAL: coerce via str(), never Decimal(float). See §7.2.
        return Decimal(str(raw))                                 # 150.25 -> Decimal('150.25')

    raise ValueError(f"unknown price unit: {unit!r}")
```

> **The sentinel guard in `FIXED_POINT_1E9` is the single most important line in this file.** It is the
> difference between "no trade" and "a $9.2 billion trade." Every provider that uses an in-band sentinel
> (Databento `UNDEF_PRICE`, some feeds use `0`, `-1`, or `2147483647`) needs an explicit guard in its
> adapter. **Document each provider's null/sentinel value next to its `PriceUnit`.**

---

## 4. Scale factors: millions, thousands, and the 1,000,000× error

### 4.1 The problem

Fundamental data (income statements, balance sheets, market cap, revenue, volume aggregates) is routinely
reported **pre-scaled**: a value of `383285` that *means* `383,285,000,000` because the statement is
"in millions." The scale is **metadata on the label**, not on the number — and when you ingest the number
without the label, you lose three to nine zeros.

XBRL — the standard the SEC mandates for US filings — handles this explicitly and warns about exactly this
trap. The `decimals` attribute encodes rounding precision, and statements declare scale:

> "rounded or truncated to millions: `decimals="-6"`" and "rounded or truncated to thousands:
> `decimals="-3"`" — [XBRL WGN, *Precision, Decimals and Units*](https://www.xbrl.org/WGN/precision-decimals-units/WGN-2017-01-11/precision-decimals-units-WGN-2017-01-11.html)

And the comparability hazard it explicitly names — *the same fact at two scales*:

> "the shares of common stock outstanding may be quoted as '707,662,632' on a financial statement cover
> sheet and as '707.7 million' in the balance sheet." — [XBRL WGN](https://www.xbrl.org/WGN/precision-decimals-units/WGN-2017-01-11/precision-decimals-units-WGN-2017-01-11.html)

Two providers can hand you `707662632` and `707.7` for the *same* `shares_outstanding`. If your canonical
convention is **absolute** (§2), both must arrive as `707_662_632` — the second multiplied by `1e6` (and
flagged as low-precision: it was rounded to the nearest 100,000).

### 4.2 Where scale hides per provider

| Source | Common scale convention | How it's declared |
|---|---|---|
| SEC EDGAR XBRL | absolute (the XBRL fact value is absolute; `decimals` is *rounding*, not scale) — but the **rendered** filing applies a `scale` to the display | `decimals` attribute; display scale in the presentation linkbase |
| FMP / vendor "financials" JSON | often **absolute** for `revenue`, but check; some endpoints report `marketCap` absolute, `volume` absolute | undocumented — **verify empirically per field** |
| Vendor "in thousands" CSV exports | thousands | column header text only — un-machine-readable |
| Index/ETF holdings files | weights as percent OR decimal; values absolute or in thousands | provider doc |

> **`decimals` is NOT scale.** A common rookie error: reading XBRL `decimals="-6"` as "multiply by 1e6."
> It means **"this value is accurate to the nearest million"** (rounding precision), and the XBRL fact
> value is *already absolute*. As the standard says outright:
> *"The `@decimals` and `@precision` attributes do not imply any kind of scaling of the values of numeric
> elements."* — [XBRL WGN](https://www.xbrl.org/WGN/precision-decimals-units/WGN-2017-01-11/precision-decimals-units-WGN-2017-01-11.html).
> So `decimals` tells you the *uncertainty* of the value (record it!), not how to scale it. Scale comes
> from a *separate* declaration (the vendor's "in millions" or the presentation linkbase `scale`).

### 4.3 Reference implementation — scale normalization

```python
from decimal import Decimal
from enum import IntEnum
from typing import Optional


class Scale(IntEnum):
    """Power-of-ten multiplier to reach ABSOLUTE units. value = reported * 10**scale."""
    ABSOLUTE = 0       # 383285000000 already absolute
    THOUSANDS = 3      # 383285 means 383,285,000
    MILLIONS = 6       # 383285 means 383,285,000,000  (the classic 10-K convention)
    BILLIONS = 9


def normalize_scale(reported, scale: Scale) -> Optional[Decimal]:
    """Bring a pre-scaled monetary/count value to ABSOLUTE.
    Money/large counts use Decimal (exact). value = reported * 10**scale.
    """
    if reported is None:
        return None
    return Decimal(str(reported)) * (Decimal(10) ** int(scale))   # 383285 @ MILLIONS -> 383285000000


# Record BOTH the source scale and the rounding precision (XBRL `decimals`) in provenance:
#   provenance = {"scale_applied": "MILLIONS", "source_decimals": -6, ...}
# so a downstream consumer knows 383285000000 is accurate only to ~+/- 500,000.
```

> **Aggregation hazard (from XBRL, applies to us):** values rounded at different scales **do not sum
> cleanly.** XBRL's Table 1 shows EPS components `1.30 + 0.01 + 1.28` that, each `decimals="2"`, "don't
> mathematically sum correctly despite individual accuracy claims"
> ([XBRL WGN](https://www.xbrl.org/WGN/precision-decimals-units/WGN-2017-01-11/precision-decimals-units-WGN-2017-01-11.html)).
> If you sum a million-scaled revenue with a thousand-scaled segment revenue **after** normalizing both to
> absolute, the answer carries the *coarser* precision. Never present a derived total at higher precision
> than its lowest-precision input.

---

## 5. Rate and yield representation: the 100× / 10,000× silent error

### 5.1 The three rate representations — and the exact conversions

A single rate (a bond yield, a coupon, a dividend yield, a daily return, a fee, an interest rate) is
expressed three mutually-incompatible ways across providers:

| Representation | "Four point five two percent" looks like | Multiplier to **decimal** |
|---|---|---|
| **Decimal fraction** (our canonical) | `0.0452` | × 1 |
| **Percent** | `4.52` | × `1/100` = `0.01` |
| **Basis points (bps)** | `452` | × `1/10000` = `0.0001` |

The exact, unambiguous relationships
([Good Calculators, *Basis Points Conversion*](https://goodcalculators.com/basis-points-conversion-calculator/);
[Omni Calculator, *Basis Point*](https://www.omnicalculator.com/finance/basis-point)):

> "One basis point is equal to 1/100th of 1%, or 0.01%. In decimal form, one basis point is equal to
> 0.0001." — [Good Calculators](https://goodcalculators.com/basis-points-conversion-calculator/)

```
1 bps  = 0.01%      = 0.0001 decimal
50 bps = 0.50%      = 0.0050 decimal
100 bps = 1%        = 0.01   decimal
500 bps = 5%        = 0.05   decimal
10000 bps = 100%    = 1.0    decimal

Conversions:
  bps  -> percent  :  bps / 100
  bps  -> decimal  :  bps / 10000
  percent -> bps   :  pct * 100
  percent -> decimal: pct / 100
  decimal -> bps   :  dec * 10000
  decimal -> percent: dec * 100
```

### 5.2 Why this is the most dangerous axis

The errors here are **clean powers of ten that still look plausible**:

- Read a **percent** (`4.52`) as a **decimal** → you've stored a 452% yield. (100× too big.)
- Read **basis points** (`452`) as a **percent** → 452% again. (100× too big.)
- Read **basis points** (`452`) as a **decimal** → a 45,200% yield. (10,000× too big.)
- Read a **decimal** (`0.0452`) as a **percent** → 0.0452% — a yield of basically zero. (100× too small.)

A 4.52% yield rendered as 452% might get caught by a human. A 4.52% yield rendered as **0.0452%** (the
decimal-read-as-percent direction) looks like a rounding artifact and sails straight through. **Both
directions are bugs; the small-direction one is the sneaky one.**

This axis also collides with **XBRL's own rule**, which mandates the decimal form for exactly this reason:

> "Rates, percentages and ratios MUST be reported using decimal or scientific notation rather than in
> percentages where the value has been multiplied by 100." For example, 34% must be `0.34` with a `pure`
> unit, not `34`. — [XBRL WGN](https://www.xbrl.org/WGN/precision-decimals-units/WGN-2017-01-11/precision-decimals-units-WGN-2017-01-11.html)

So XBRL filings give you `0.34` (decimal) — but a REST vendor will hand you `34` (percent) for the *same*
ratio. The canonical convention (decimal) means the XBRL value passes through unchanged and the vendor
value is divided by 100.

### 5.3 Percentage points vs percent — a related, distinct trap

Not a units conversion but a **semantic** one that bites in derived fields like "change in yield":

- A move **from 5% to 6%** is **+1 percentage point** (`pp`) — the *arithmetic* difference of two rates.
- That **same move** is a **+20 percent** *relative* change: `(6 − 5)/5 = 0.20`.
- And the unemployment example: **4% → 6%** is "a 50 percent increase but a 2 percentage point increase"
  ([percentage point discussion](https://en.wikipedia.org/wiki/Percentage_point)).

> "A percentage point is the arithmetic difference between two percentages. In contrast, percent describes
> how much a number has changed in relation to a previous number." —
> [Wikipedia, *Percentage point*](https://en.wikipedia.org/wiki/Percentage_point)

If a provider's `yield_change` field is **percentage points** and you label it "% change," you've conflated
a 1pp move with a 1% move. Capture the field's *kind* (`pp` vs relative `%`) in provenance; do not silently
coerce one into the other. The unit abbreviation is `pp`, `p.p.`, or `%pt`
([Wikipedia](https://en.wikipedia.org/wiki/Percentage_point)).

### 5.4 Reference implementation — rate normalization

```python
from decimal import Decimal
from enum import Enum
from typing import Optional


class RateUnit(str, Enum):
    DECIMAL = "decimal"       # 0.0452  (canonical; XBRL `pure` ratios arrive here)
    PERCENT = "percent"       # 4.52    (most REST vendors)
    BASIS_POINTS = "bps"      # 452     (rates desks, spreads, fee schedules)


_RATE_TO_DECIMAL = {
    RateUnit.DECIMAL: Decimal(1),
    RateUnit.PERCENT: Decimal(1) / Decimal(100),      # /100
    RateUnit.BASIS_POINTS: Decimal(1) / Decimal(10000),  # /10000
}


def normalize_rate(raw, unit: RateUnit) -> Optional[Decimal]:
    """Convert any rate representation to the canonical DECIMAL fraction.
    4.52% -> Decimal('0.0452');  452 bps -> Decimal('0.0452');  0.0452 -> Decimal('0.0452').
    """
    if raw is None:
        return None
    return Decimal(str(raw)) * _RATE_TO_DECIMAL[unit]
```

> **Sanity bound as a tripwire (defense in depth, not a substitute for knowing the unit).** A nominal
> yield/rate field whose normalized decimal value lands **outside `[-1.0, 1.0]`** (i.e. below −100% or above
> +100%) is almost certainly a misread unit — log/flag it. A 30Y Treasury at `4.52` decimal (= 452%) trips
> this; at `0.0452` it doesn't. This catches the 100×/10,000× errors that escaped the per-provider config.
> (Caveat: some rates legitimately exceed 100% — hyperinflation CPI, certain crypto APYs — so this is a
> *flag for review*, never an auto-correct.)

---

## 6. Currency: the unit that makes the number mean something

### 6.1 A price without a currency is not a number

`150.25` is meaningless until you know it's `USD`. Two failures:

1. **Missing currency.** The canonical record MUST carry `currency` (ISO 4217 alpha-3). A `price` field
   with no `currency` is incomplete data, not a usable value.
2. **Implicit/assumed currency.** Assuming "everything is USD" breaks the instant you ingest a `.TO`
   (Toronto, CAD), `.L` (London, GBP/GBX), `.T` (Tokyo, JPY), or `.NS` (NSE India, INR) ticker. London is
   a *double* trap: LSE quotes many stocks in **pence (GBX)**, not pounds — a "cents-vs-dollars" problem
   *inside* a currency.

### 6.2 ISO 4217 and minor-unit exponents (cents are not universal)

The "divide by 100" cents rule is **currency-specific**. ISO 4217 assigns each currency a *minor-unit
exponent*:

> "In ISO 4217, '0' means that there is no minor unit for that currency, whereas '1', '2' and '3' signify a
> ratio of 10:1, 100:1 and 1000:1 respectively." — [ISO 4217 (Wikipedia)](https://en.wikipedia.org/wiki/ISO_4217)

| Currency | Exponent | Minor units per major | Implication |
|---|---|---|---|
| **JPY** (yen) | **0** | 1 (no minor unit in practice) | a "cents" integer feed for JPY divides by **1**, not 100 — ¥15025 *is* ¥15025 |
| **USD**, **EUR**, **GBP** | **2** | 100 | cents/pence: divide by 100 |
| **BHD** (Bahraini dinar), KWD, OMR | **3** | 1000 | "fils": divide by **1000** |

> "the code JPY is given the exponent 0, because its minor unit, the sen … is of such negligible value that
> it is no longer used." / "USD … exponent 2 … 100 of its minor currency unit the 'cent'." / "BHD … minor
> unit showing '3' … 1,000 subunits." — [ISO 4217 (Wikipedia)](https://en.wikipedia.org/wiki/ISO_4217)

**Consequence for §3.4:** the `CENTS_INT` branch hard-coded `/ 100`. That is **wrong for JPY and BHD.** The
minor→major divisor is `10 ** iso4217_exponent(currency)`. The corrected, currency-aware version is in
§6.5.

### 6.3 The minor-unit table (the part you actually code against)

```python
# ISO 4217 minor-unit exponent: minor units per major unit = 10 ** exponent.
# Source: ISO 4217 (en.wikipedia.org/wiki/ISO_4217). Pin to the official list; this is a working subset.
ISO4217_MINOR_EXPONENT = {
    "USD": 2, "EUR": 2, "GBP": 2, "CAD": 2, "AUD": 2, "CHF": 2, "CNY": 2,
    "INR": 2, "HKD": 2, "SGD": 2, "BRL": 2, "MXN": 2, "ZAR": 2,
    "JPY": 0, "KRW": 0,                 # no minor unit -> divide by 1
    "BHD": 3, "KWD": 3, "OMR": 3, "JOD": 3, "TND": 3,  # millièmes/fils -> divide by 1000
    "GBX": 2,  # GBX = pence; 100 GBX = 1 GBP. Handle GBX -> GBP as its own step (see §6.4).
}

def minor_unit_divisor(currency: str) -> int:
    """How many minor units in one major unit. USD->100, JPY->1, BHD->1000."""
    return 10 ** ISO4217_MINOR_EXPONENT[currency.upper()]
```

### 6.4 FX conversion policy: *which* rate, *when*, recorded *how*

If the product converts currencies (e.g. to present a USD-normalized portfolio), the conversion is itself a
fact that must be governed and recorded. Three sub-decisions:

**(a) Direction.** An FX rate is directional: `USDJPY = 150.25` means "150.25 JPY per 1 USD." Store the
convention explicitly (`quote ccy per 1 base ccy`) so nobody inverts it. Inverting an FX rate is the same
class of silent error as bps-vs-percent.

**(b) Which rate.** Accounting standards distinguish the **spot/current** rate from a **historical** rate,
and the choice changes the answer:

> "For assets and liabilities, the exchange rate at the balance sheet date shall be used. For revenues,
> expenses, gains, and losses, the exchange rate at the dates on which those elements are recognized shall
> be used." — [PwC Viewpoint, *Exchange rates*](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/foreign_currency/foreign_currency__2_US/chapter_5_translatin_US/55_exchange_rates_US.html) (ASC 830 / IAS 21)

For live market quotes we convert at the **contemporaneous spot rate** (the rate at the quote's timestamp);
for historical statement items we use the **rate as of the recognition date**. Mixing them silently is a
reproducibility bug.

**(c) Record it.** The standards mandate *disclosure of the rate used* — and so do we:

> "When material, disclosures should include the rates used for remeasurement and translation … the reasons
> for using two different rates." — [PwC Viewpoint](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/foreign_currency/foreign_currency__2_US/chapter_5_translatin_US/55_exchange_rates_US.html)

A converted value's provenance MUST carry `{original_currency, original_value, fx_rate, fx_rate_as_of,
fx_source}`. Without it, the converted number is **unreproducible** — you cannot answer "why is this
₹-denominated stock shown at $X?" six months later.

> **GREEN FX source (licensing).** Public-domain FX rates exist and should be preferred for *display*:
> the [U.S. Treasury Reporting Rates of Exchange](https://fiscaldata.treasury.gov/datasets/treasury-reporting-rates-exchange/)
> and the [Federal Reserve H.10 release](https://www.federalreserve.gov/releases/h10/current/) are
> US-government public-domain (17 USC §105 class). A *free-tier* FX endpoint from a commercial vendor is
> **not** a display license. (Cross-ref the commercial-ok gate discipline carried over from the broader
> program; record `fx_source` so the license is auditable.)

### 6.5 Reference implementation — currency-aware price + FX

```python
from decimal import Decimal
from typing import Optional


def normalize_minor_to_major(raw_minor, currency: str) -> Optional[Decimal]:
    """Currency-aware cents->dollars. USD: /100, JPY: /1, BHD: /1000.
    Replaces the hard-coded /100 in the naive §3.4 CENTS_INT branch.
    """
    if raw_minor is None:
        return None
    return Decimal(int(raw_minor)) / Decimal(minor_unit_divisor(currency))


def normalize_gbx_to_gbp(raw_gbx) -> Optional[Decimal]:
    """LSE quotes pence (GBX). 100 GBX = 1 GBP. A 'cents inside a currency' case."""
    if raw_gbx is None:
        return None
    return Decimal(str(raw_gbx)) / Decimal(100)


def convert_currency(
    value: Decimal,
    from_ccy: str,
    to_ccy: str,
    fx_rate: Decimal,            # units of `to_ccy` per 1 unit of `from_ccy`
) -> Decimal:
    """Convert money across currencies. Caller records {fx_rate, fx_rate_as_of, fx_source}
    in provenance — this function does the arithmetic only.
    """
    if from_ccy == to_ccy:
        return value
    return value * fx_rate       # Decimal * Decimal stays exact; round only at display (§7.4)
```

---

## 7. Money is `Decimal`, never `float` — and how to coerce safely

### 7.1 Why float is disqualified for money (the standard verdict)

Storing money as binary float is a documented anti-pattern. Crunchy Data's Postgres money guide and the
PostgreSQL manual both steer to exact numeric types:

> "Numeric is widely considered the ideal datatype for storing money in Postgres. … Use decimal/numeric for
> storing money … Store your money in cents and convert to a decimal on your output." —
> [Crunchy Data, *Working with Money in Postgres*](https://www.crunchydata.com/blog/working-with-money-in-postgres)

Two viable storage strategies, both exact (avoid `float`/`real`/`double precision` and avoid Postgres's own
`money` type, which is locale-dependent and discouraged
([PostgreSQL Monetary Types](https://www.postgresql.org/docs/current/datatype-money.html))):

| Strategy | Postgres type | Python type | When |
|---|---|---|---|
| **Decimal numeric** | `NUMERIC(p, s)` (e.g. `NUMERIC(20,8)`) | `Decimal` | default for analytics; fractional cents/sub-units OK |
| **Integer minor units** | `BIGINT` (cents) | `int` | hot path / high write volume; "Store your money in cents" |

Crunchy notes the trade: `NUMERIC` is "10 bytes per column row" and slower; `BIGINT` is "only a 4 byte
sized column, 8 if you're using bigint … notably performant and storage efficient"
([Crunchy Data](https://www.crunchydata.com/blog/working-with-money-in-postgres)). **Our canonical
in-flight type is `Decimal`**; the warehouse row type is a downstream choice (see `timescaledb-timeseries`).

### 7.2 The ONE coercion rule: `Decimal(str(x))`, never `Decimal(float)`

This is the single most-violated rule in money code. Constructing a `Decimal` directly from a float copies
the float's *inexactness* into the Decimal:

```python
>>> from decimal import Decimal
>>> Decimal(0.1)
Decimal('0.1000000000000000055511151231257827021181583404541015625')   # WRONG — float's true binary value
>>> Decimal('0.1')
Decimal('0.1')                                                          # RIGHT — exact
>>> Decimal(str(0.1))
Decimal('0.1')                                                          # RIGHT — str() gives the short repr
```
— [Python `decimal` docs](https://docs.python.org/3/library/decimal.html): *"specifying a string creates a
Decimal with exactly that value … specifying a floating point number creates a Decimal with the actual
value."*

**Rule:** every value that may arrive as a float (REST JSON numbers deserialize to Python `float`) is
coerced with `Decimal(str(value))`. Best is to never let it become a float at all — many JSON libraries can
parse numbers directly to `Decimal`:

```python
import json
from decimal import Decimal

# Parse JSON numbers straight to Decimal, skipping the lossy float step entirely.
data = json.loads(raw_body, parse_float=Decimal, parse_int=Decimal)
# Now data["price"] is already Decimal('150.25'), never float 150.25.
```

> For Pydantic v2 models (the data-plane's modeling layer), type the field `Decimal` and feed it the *raw
> string* from the payload, or configure the source to parse numbers as `Decimal`. A `float`-typed Pydantic
> field has already lost precision before validation runs — the damage is done upstream of the model.

### 7.3 Context precision and the 28-digit default

Python's `decimal` defaults to 28 significant digits of working precision — ample for money, but know it's
*significant digits*, not decimal places:

> "The default precision is 28 decimal places: `Context(prec=28, rounding=ROUND_HALF_EVEN, ...)`" —
> [Python `decimal` docs](https://docs.python.org/3/library/decimal.html)

`prec=28` bounds total significant digits across an arithmetic result; it does **not** fix the number of
places after the decimal point. To fix decimal places (e.g. "always 2 for USD cents") you `quantize` (§7.4).

### 7.4 Rounding: `quantize`, and which rounding mode

Round **only at the edge** (display, or persisting to a fixed-scale column) — never mid-pipeline. Use
`quantize` to fix decimal places:

```python
>>> from decimal import Decimal, ROUND_HALF_UP
>>> Decimal('7.325').quantize(Decimal('.01'), rounding=ROUND_DOWN)
Decimal('7.32')
>>> Decimal('2.675').quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
Decimal('2.68')   # what a human expects for money; float round(2.675,2) gives 2.67 (wrong)
```
— [Python `decimal` docs](https://docs.python.org/3/library/decimal.html)

**Mode matters.** The Decimal default is **`ROUND_HALF_EVEN`** ("banker's rounding" — ties go to the even
digit, statistically unbiased over many roundings)
([Python docs](https://docs.python.org/3/library/decimal.html)). For *displayed currency* most products
expect **`ROUND_HALF_UP`** (the schoolbook "round half up"). Pick deliberately per surface and document it;
the two disagree on exact halves (`2.675 → 2.68` HALF_UP vs the even-digit choice under HALF_EVEN). For
**internal money math, do not round at all** until the final presentation step — intermediate rounding
accumulates error exactly like float drift.

Quantize to the **currency's** minor-unit scale, not a hard-coded 2:

```python
from decimal import Decimal, ROUND_HALF_UP

def quantize_for_currency(value: Decimal, currency: str) -> Decimal:
    """Round a Decimal to the currency's minor-unit places for DISPLAY only.
    USD -> 2 places, JPY -> 0 places, BHD -> 3 places. (ISO 4217 exponent, §6.2/6.3)
    """
    places = ISO4217_MINOR_EXPONENT[currency.upper()]
    if places == 0:
        return value.quantize(Decimal(1), rounding=ROUND_HALF_UP)        # JPY: integer yen
    return value.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)  # 10**-places
```

### 7.5 FX precision: significant digits vs decimal places

FX rates expose the *significant-digits-vs-decimal-places* distinction. Major pairs carry **4 decimal
places** where **1 pip = 0.0001**; JPY pairs carry **2 decimal places** where **1 pip = 0.01**; brokers
often add a fifth/third "fractional pip" (pipette) for sub-pip granularity
([OANDA, *What is a pip*](https://www.oanda.com/uk-en/trading/learn/introduction-to-leverage-trading/what-is-a-pip/)):

- EUR/USD `1.1600 → 1.1605` is a **5-pip** move (`0.0005`), so **1 pip = 0.0001** (4 dp).
- USD/JPY is quoted to **2 dp**; **1 pip = 0.01**; "you have to look at the second digit after the decimal."
- Fractional pips ("pipettes") add a 5th decimal for non-JPY and a 3rd for JPY.

The lesson for normalization: an FX rate's *meaningful precision* is currency-pair-specific. Storing FX as
`Decimal` preserves whatever precision the source provides; **never truncate an FX rate to 2 dp** (that
destroys 2 pips of a 4-dp pair). Decide display rounding per pair, store full precision.

---

## 8. Provenance: the conversion must be auditable and reversible

Every normalized value carries a provenance record of *how it got there*. This is what turns a normalized
number from "trust me" into "here is the audit trail." Without it, you cannot answer the only two questions
that matter when a number looks wrong: **was the conversion correct?** and **what was the raw input?**

```python
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional


@dataclass(frozen=True)
class ValueProvenance:
    """Attached to every normalized numeric value. Auditable + reversible."""
    provider: str                       # "databento" | "twelve_data" | "fmp" | ...
    source_field: str                   # the raw key, e.g. "regularMarketPrice"
    raw_value: str                      # the raw value AS A STRING (exact, no float loss)
    # --- the conventions detected on the source ---
    source_unit: Optional[str] = None        # "fixed_point_1e9" | "cents_int" | "percent" | "bps" | ...
    scale_applied: Optional[str] = None      # "MILLIONS" | "ABSOLUTE" | ...  (§4)
    source_decimals: Optional[int] = None    # XBRL `decimals` rounding precision, e.g. -6 (§4.2)
    currency: Optional[str] = None           # ISO 4217 alpha-3 (§6)
    # --- FX, only if a conversion happened (§6.4) ---
    fx_rate: Optional[str] = None            # quote-per-base, as string
    fx_rate_as_of: Optional[str] = None      # ISO-8601 timestamp of the rate used
    fx_source: Optional[str] = None          # "treasury" | "fed_h10" | vendor
    # --- license gate carried through (program-wide discipline) ---
    commercial_ok: bool = False              # default RED; only True if the fetch path is cleared


@dataclass(frozen=True)
class NormalizedValue:
    value: Optional[Decimal]            # canonical convention (§2); None if sentinel/missing
    provenance: ValueProvenance
```

The reversibility property: given `provenance`, you can reconstruct the raw value and re-derive the
canonical one — `Decimal(raw_value) * scale * fx`, etc. The auditability property: a reviewer (or the
red-team negation loop) can check that `source_unit` + `scale_applied` actually map `raw_value` to `value`.
If `value` and `provenance` disagree, that's a caught bug instead of a shipped one.

> **Tie-in to the program's non-negotiables.** "Never invent a finance number" means *every* displayed
> number traces to a fetched raw value via a recorded conversion. Provenance is the mechanism that makes
> that checkable. A normalized value with no provenance is, by this product line's standard, an
> *un-grounded* number — treat it as `unavailable`.

---

## 9. Putting it together: the `transform_data` contract

`transform_data(raw_record, provider) → list[NormalizedValue]` is where ALL of the above lives. The
per-provider knowledge (what unit each field uses, the scale, the currency source, the sentinel) is
**config local to the adapter**; downstream code sees only canonical values + provenance.

```python
from decimal import Decimal
from typing import Any


# Per-provider field convention config. This table IS the institutional knowledge.
# Verify each entry empirically against real payloads; do not assume.
PROVIDER_FIELD_CONFIG = {
    "databento": {
        "price":  {"unit": "fixed_point_1e9", "kind": "price"},   # 1e-9 scale + UNDEF_PRICE sentinel
        "size":   {"unit": "absolute_int",    "kind": "count"},
    },
    "twelve_data": {
        "close":  {"unit": "dollars_float", "kind": "price"},     # currency from the symbol's exchange
        "volume": {"unit": "absolute_int",  "kind": "count"},
        "percent_change": {"unit": "percent", "kind": "rate"},    # "1.23" means 1.23% -> 0.0123
    },
    "fmp_financials": {
        "revenue":    {"unit": "absolute", "scale": "ABSOLUTE", "kind": "money"},  # verify per endpoint!
        "marketCap":  {"unit": "absolute", "scale": "ABSOLUTE", "kind": "money"},
    },
    "xbrl": {
        "Revenues":   {"unit": "decimal_ratio_or_money", "kind": "money"},  # value absolute; carry `decimals`
    },
}


def transform_value(raw, field_cfg: dict, currency: str, provider: str, source_field: str) -> NormalizedValue:
    """Single field -> canonical value + provenance. Dispatches on `kind`."""
    kind = field_cfg["kind"]
    prov_kwargs = dict(provider=provider, source_field=source_field, raw_value=str(raw), currency=currency)

    if kind == "price":
        unit = PriceUnit(field_cfg["unit"]) if field_cfg["unit"] != "absolute_int" else None
        value = normalize_price(raw, unit) if unit else Decimal(str(raw))
        prov = ValueProvenance(source_unit=field_cfg["unit"], **prov_kwargs)

    elif kind == "money":
        scale = Scale[field_cfg.get("scale", "ABSOLUTE")]
        value = normalize_scale(raw, scale)
        prov = ValueProvenance(source_unit=field_cfg["unit"], scale_applied=scale.name, **prov_kwargs)

    elif kind == "rate":
        value = normalize_rate(raw, RateUnit(field_cfg["unit"]))
        prov = ValueProvenance(source_unit=field_cfg["unit"], **prov_kwargs)

    elif kind == "count":
        value = None if raw is None else Decimal(int(raw))   # exact integer count
        prov = ValueProvenance(source_unit="absolute_int", **prov_kwargs)

    else:
        raise ValueError(f"unknown field kind: {kind!r}")

    return NormalizedValue(value=value, provenance=prov)
```

**The five rules this contract enforces, restated:**

1. **One canonical convention per field** — every adapter targets the §2 table.
2. **Convert in the adapter** — convention is provider-local config; downstream sees canonical only.
3. **Provenance on every value** — `{source_unit, scale_applied, source_decimals, currency, fx_*}`.
4. **Sentinels → `None`, never a number** — `UNDEF_PRICE` and friends are guarded explicitly.
5. **Money is `Decimal`, coerced via `str()`** — no `float` ever touches a money path.

---

## 10. Anti-patterns → fixes (quick reference)

| Anti-pattern (the bug) | Fix |
|---|---|
| Map `price` field name, trust the value | Map the *value's convention* too: detect unit/scale/currency, convert in the adapter |
| `Decimal(raw_float)` for money | `Decimal(str(raw))`, or `json.loads(body, parse_float=Decimal)` (§7.2) |
| `float` for any money/price | `Decimal` in-flight; `NUMERIC`/`BIGINT-cents` at rest (§7.1) |
| Read `452` (bps) as a percent → 452% | Per-field `RateUnit` config; canonical = decimal; `bps/10000` (§5) |
| Hard-coded `/ 100` for cents | Currency-aware `10 ** iso4217_exponent` (JPY÷1, BHD÷1000) (§6.2) |
| Run scale divide on `UNDEF_PRICE` → "$9.2B trade" | Sentinel guard: `if raw == UNDEF_PRICE: return None` (§3.4) |
| Read XBRL `decimals="-6"` as "×1e6 scale" | `decimals` = rounding precision, NOT scale; record it, don't multiply (§4.2) |
| Assume everything is USD | Require `currency` per record; handle GBX, JPY, `.TO`/`.L`/`.T` suffixes (§6.1) |
| Convert FX without recording the rate | Provenance `{fx_rate, fx_rate_as_of, fx_source}`; pick spot vs historical deliberately (§6.4) |
| Round mid-pipeline | Round only at display/persist edge, `quantize` to the currency's minor-unit places (§7.4) |
| Sum values rounded at different scales, present at full precision | Derived total carries the *coarsest* input precision (§4.3) |
| Label a percentage-point move as "% change" | `pp` (arithmetic Δ) ≠ relative `%`; capture the kind in provenance (§5.3) |
| Truncate an FX rate to 2 dp | Store full FX precision; major pairs need 4-5 dp (a pip is 0.0001) (§7.5) |
| A value with no provenance | An un-grounded number → treat as `unavailable` (§8) |

---

## 11. Scale (R-SCALE) note for this surface

Value normalization runs in the **ingest/transform path**, not the request path — so its scale story is
about **throughput**, not contested writes:

- **Tier 1 (demo, ≤1k rows/batch):** `Decimal` everywhere, naive per-row `transform_value`. Fine.
- **Tier 100× (10k-100k rows/batch):** `Decimal` is ~10-100× slower than `float`; per-row Python dispatch
  dominates. Mitigation: keep `Decimal` only on **money/price/rate** fields; counts and IDs stay native
  `int`. Batch-transform; avoid re-constructing the config dict per row.
- **Tier 10,000× (1M+ rows, vectorized):** per-row `Decimal` in pure Python won't keep up. Options:
  (a) store money as **`BIGINT` minor units** and do integer math vectorized (numpy/Arrow), converting to
  `Decimal` only at the API edge; (b) push the scale/unit arithmetic into the warehouse (`NUMERIC` columns
  + SQL), so the heavy transform runs in Postgres/Timescale, not Python. The **transform stays off the
  request path** regardless — it's a `worker`/batch concern (program non-negotiable: heavy/scheduled work
  runs off the request path).

State the tier each ingest pipeline targets and what breaks at the next, in its own design doc. The
*correctness* rules above are tier-independent; only the *execution strategy* changes with scale.

---

## Sources

- Databento — *Normalization* (price units cents/dollars/index points; float-vs-fixed-point trade-off):
  https://databento.com/microstructure/normalization
- Databento — *Databento Binary Encoding (DBN)* (`$1.25 = 1250000000`, 1e-9 fixed-point):
  https://databento.com/docs/standards-and-conventions/databento-binary-encoding
- Databento DBN source — `rust/dbn/src/lib.rs` (`FIXED_PRICE_SCALE = 1_000_000_000`, `UNDEF_PRICE = i64::MAX`):
  https://github.com/databento/dbn/blob/main/rust/dbn/src/lib.rs · CHANGELOG (UNDEF_* constants for null filtering): https://github.com/databento/dbn/blob/main/CHANGELOG.md
- Good Calculators — *Basis Points Conversion* (1 bps = 0.01% = 0.0001):
  https://goodcalculators.com/basis-points-conversion-calculator/ · Omni Calculator — *Basis Point*: https://www.omnicalculator.com/finance/basis-point
- Wikipedia — *Percentage point* (pp = arithmetic Δ vs relative %; 4%→6% = +2pp = +50%):
  https://en.wikipedia.org/wiki/Percentage_point
- XBRL WGN — *Precision, Decimals and Units* (decimals≠scale; `decimals="-6"`=millions rounding; ratios MUST be decimal `0.34`; 707,662,632 vs 707.7M):
  https://www.xbrl.org/WGN/precision-decimals-units/WGN-2017-01-11/precision-decimals-units-WGN-2017-01-11.html
- ISO 4217 (Wikipedia) — currency minor-unit exponents (JPY=0, USD=2, BHD=3):
  https://en.wikipedia.org/wiki/ISO_4217
- Crunchy Data — *Working with Money in Postgres* (NUMERIC ideal; store cents in BIGINT; floats problematic):
  https://www.crunchydata.com/blog/working-with-money-in-postgres · PostgreSQL — *Monetary Types* (money type discouraged): https://www.postgresql.org/docs/current/datatype-money.html
- Python docs — `decimal` (Decimal(0.1) inexact vs Decimal('0.1') exact; prec=28; ROUND_HALF_EVEN default; quantize; 0.1+0.1+0.1-0.3):
  https://docs.python.org/3/library/decimal.html
- OANDA — *What is a pip* (1 pip = 0.0001; JPY pairs 2 dp = 0.01; fractional pips/pipettes):
  https://www.oanda.com/uk-en/trading/learn/introduction-to-leverage-trading/what-is-a-pip/
- PwC Viewpoint — *Exchange rates* (ASC 830 / IAS 21: spot at balance-sheet date vs rate at recognition; disclose rates used):
  https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/foreign_currency/foreign_currency__2_US/chapter_5_translatin_US/55_exchange_rates_US.html · U.S. Treasury Reporting Rates of Exchange (GREEN FX): https://fiscaldata.treasury.gov/datasets/treasury-reporting-rates-exchange/ · Federal Reserve H.10: https://www.federalreserve.gov/releases/h10/current/
