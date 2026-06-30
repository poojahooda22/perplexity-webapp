# Patterns — Data-Quality Validation (the "GREEN-but-wrong" gate)

> **Skill:** `data-normalization-tet` (the clean-room OpenBB **Transform-Extract-Transform** write-path normalization skill).
> **Product line:** JPM-Markets re-engineering **data-analytics** product line (DataQuery + Fusion), a **separate product** — **NOT Lumina**, not wired into this repo's app. New Python/FastAPI/data-engineering stack.
> **This reference is a `patterns-*` build recipe** (concrete, runnable), not generic theory.
> **Scope of THIS doc:** the **quality gate that runs on already-normalized output, before it persists.** It catches the *second* half of "never invent a finance number": a number that is correctly fetched from a GREEN public-domain source and correctly field-mapped, but is **internally inconsistent or statistically impossible** — a high below its low, a 10,000% one-day jump, a stale flat-line, a negative price. The source is GREEN; the number is **wrong**. ([`00-theory.md`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md): *"A GREEN source can still produce a wrong number … GREEN-but-wrong still violates 'never invent a finance number' — ground and validate."*; [`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md).)
>
> **Where this sits in the TET pipeline.** The write path is `transform_query → aextract_data → transform_data → PERSIST`. This doc is the validation that lives **at the tail of `transform_data` and as a post-batch gate before the INSERT/upsert**. Field aliasing, symbology resolution, and the standard-model shape are covered by the sibling `patterns-*`/`theory-*` references; here we assume the row is *already* the standard OHLCV (or fundamentals) shape and ask the one remaining question: **is this number plausibly real?**

---

## 0. The one-paragraph thesis

A normalized record that passes Pydantic *shape* validation (right columns, right dtypes, non-null) can still be **factually corrupt**: providers ship inverted bars, decimal-shifted prices (split not applied), duplicated XBRL facts, frozen feeds, and unit mix-ups. The license gate (`commercialOk`) and the shape gate (the standard model) say nothing about correctness. So the write path needs a **third gate** between normalization and persistence: a **data-quality gate** that runs (a) **cheap deterministic invariants** per-row inline in `transform_data` (OHLC consistency, non-negativity), and (b) **statistical / cross-source checks** on the assembled batch (outlier z-bounds, stale-run detection, two-provider reconciliation, row-count drift). A failure **quarantines or flags** the offending rows — it **never silently drops** them to "look complete," and it **never backfills** a fabricated value. The whole gate is the operational meaning of "ground *and validate*."

---

## 1. Why a separate gate — the three orthogonal questions a record must pass

A normalized series row answers three independent questions, each with its own gate. Confusing them is the central junior mistake (the same "shape == correct" reflex the theory doc flags). Keep them separate:

| Gate | Question | Mechanism | Failure verdict | Where it lives |
|---|---|---|---|---|
| **License gate** | "Am I allowed to display/redistribute this?" | `Provenance{commercialOk}` bound to the **fetch path**, checked against the sources-ledger | `commercialOk:false` (still ingest, just don't display) | stamp in `transform_data`; CI `/sources-lint` |
| **Shape gate** | "Is this the right *structure*?" | Pydantic `(Q,R)` standard model: columns present, dtypes correct, OHLCV always `open/high/low/close/volume`, non-null where required | reject row (`ValidationError`) | `transform_data` Pydantic `R` |
| **Quality gate (THIS doc)** | "Is this number plausibly *real*?" | deterministic invariants + statistical bounds + cross-source reconciliation | **quarantine / flag**, never silent-drop, never backfill | tail of `transform_data` (cheap) + post-batch gate (statistical) |

**First-principles point.** A GREEN public-domain source (SEC EDGAR, US Treasury, BLS, BEA) is *licensed* and is *usually* right — but "public domain" is a copyright fact, not a correctness guarantee. The theory doc names the canonical GREEN-but-wrong failure: *"SEC EDGAR duplicate/non-comparable XBRL facts"* — the same financial fact reported twice in a filing under different contexts, which a naive ingest reads as two different numbers. ([`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md); `00-theory.md` §"Stamp".) The quality gate is the thing that catches it. **A clean license verdict and a clean schema are necessary but not sufficient; the quality gate is the third leg.**

### The cardinal rule of this gate: what a failure does

A quality failure has exactly **three** legal outcomes, in priority order:

1. **Quarantine** — write the row to a `*_quarantine` table / a `quarantine/` Parquet path with the failed-check name and the values, and **do not** insert it into the served store. The row is *kept* (for audit and re-processing), just not *served*.
2. **Flag-and-serve** — for soft/statistical checks where you'd rather show the number with a `quality_flag` than withhold it, insert it but set a `quality_flag` column (e.g. `'outlier'`, `'stale'`) that the read path can surface or filter.
3. **Skip-with-typed-unavailable** — if a whole series fails (e.g. provider returned an all-zero column), the series resolves to the typed `unavailable` the repo already uses, **not** a fabricated fill.

**Never** do any of these (each is a non-negotiable violation):

- ❌ Silently drop failing rows so the batch "looks complete" (hides the corruption; `00-theory.md` pre-mortem #3: *"stored a RED vendor series to 'look complete'"* — the same instinct applied to bad rows).
- ❌ Backfill / interpolate a plausible value to replace the bad one *on the write path* (that **invents a finance number** — non-negotiable #1). Gapfill/interpolation is a **read-path, clearly-labelled** affordance (the TimescaleDB `gapfill`/`locf` story lives in the store skill), never a silent write-path repair.
- ❌ `try/except: pass` around the validation so a corrupt batch persists (the "swallowed error" anti-pattern from the red-team catalogue).

---

## 2. Layer A — cheap deterministic invariants (inline, per-row, in `transform_data`)

These are O(1)-per-row, no statistics, no history needed. They run **inline in the TET `transform_data`** stage (or as a row-level Pydantic `model_validator`) so a structurally-impossible bar never even reaches the batch. They are the cheapest, highest-confidence checks and they catch the most embarrassing corruption (inverted bars, negative prices).

### 2.1 The OHLC internal-consistency invariants

A single OHLC bar has a small set of **must-always-hold** relationships. The canonical rule (verified): *"check every row to verify that the low is less than or equal to the minimum of open and close, and the high is greater than or equal to the maximum of open and close"* — i.e. `low ≤ min(open, close)` and `high ≥ max(open, close)`, with `high ≥ low` implied. ([domo.com OHLC guide](https://www.domo.com/learn/charts/ohlc-chart); [Wikipedia, Open-high-low-close chart](https://en.wikipedia.org/wiki/Open-high-low-close_chart) — *"the high and low … the highest and lowest prices … open and close are marked"*.)

The complete invariant set for an equity/index/FX/crypto OHLCV bar:

| # | Invariant | Why it must hold |
|---|---|---|
| I1 | `high >= low` | by definition; violation = inverted/corrupt bar |
| I2 | `high >= open` and `high >= close` | high is the max over the bar |
| I3 | `low <= open` and `low <= close` | low is the min over the bar |
| I4 | `open > 0`, `high > 0`, `low > 0`, `close > 0` | a traded price cannot be ≤ 0 (equities/crypto). **Exception:** some *rates/spreads/yields* legitimately go negative — gate by `value_kind`, see §2.3 |
| I5 | `volume >= 0` | volume is a count; negative = corruption. `volume == 0` is *legal* (halted/illiquid session) but worth a soft flag |
| I6 | `adj_close > 0` and (if present) `adj_close <= high_unadjusted`-class sanity | adjusted series must still be positive |
| I7 | no `NaN`/`Inf` in any numeric field that I1–I6 reference | `Inf`/`NaN` silently defeat comparisons (`NaN >= x` is always `False`) |

> **The `NaN` trap (I7 is load-bearing).** In pandas/NumPy every comparison with `NaN` returns `False`, so a bar with `high = NaN` will *pass* `high >= low` as written if you're not careful (the comparison is `False`, but if you test `not (low <= ... )` your polarity flips). Always assert non-null/finite **before** the relational checks, or use `df[['open','high','low','close']].notna().all(axis=1)` as a precondition mask. ([`00-theory.md` references the dup/`NaN` class of GREEN-but-wrong.])

#### Per-row Pydantic implementation (the standard-model `R`, with the invariant as a `model_validator`)

This is the natural home for I1–I7 because the TET `transform_data` already constructs the `R` Pydantic model per row. The `@model_validator(mode='after')` runs **after** field-level validation, is an **instance method returning `Self`**, and raises `ValueError` to fail. ([pydantic.dev validators — *"creates an instance method that must return `Self`"*; *"Raise `ValueError` directly inside the validator"*](https://pydantic.dev/docs/validation/latest/concepts/validators/).)

```python
# models/ohlcv.py  — the standard-model R for an OHLCV bar (clean-room TET, no openbb-* import)
from __future__ import annotations
import math
from datetime import date
from enum import Enum
from typing_extensions import Self
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ValueKind(str, Enum):
    """Distinguishes price series (must be > 0) from rate/spread series (may be < 0)."""
    PRICE = "price"          # equities, FX, crypto, index level
    RATE = "rate"            # yields, spreads — may legitimately be negative
    COUNT = "count"          # volume, shares outstanding — must be >= 0


class OhlcvBar(BaseModel):
    # extra='allow' carries provider-extension fields without losing them (the TET escape hatch).
    model_config = ConfigDict(extra="allow", populate_by_name=True, frozen=False)

    figi: str                                   # canonical instrument id (security master)
    obs_date: date = Field(alias="date")
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    value_kind: ValueKind = ValueKind.PRICE

    @field_validator("open", "high", "low", "close", "volume", mode="after")
    @classmethod
    def _finite(cls, v: float) -> float:
        # I7 — reject NaN/Inf BEFORE any relational check (NaN comparisons are silently False).
        if v is None or math.isnan(v) or math.isinf(v):
            raise ValueError("non-finite numeric value (NaN/Inf)")
        return v

    @model_validator(mode="after")
    def _ohlc_invariants(self) -> Self:
        o, h, l, c = self.open, self.high, self.low, self.close

        # I1 / I2 / I3 — the OHLC lattice. low <= min(open,close) ; high >= max(open,close).
        if not (l <= min(o, c)):
            raise ValueError(f"OHLC: low {l} > min(open,close) {min(o, c)}")
        if not (h >= max(o, c)):
            raise ValueError(f"OHLC: high {h} < max(open,close) {max(o, c)}")
        if not (h >= l):
            raise ValueError(f"OHLC: high {h} < low {l}")

        # I4 — positivity, but ONLY for price series (rates may be negative).
        if self.value_kind is ValueKind.PRICE:
            for name, v in (("open", o), ("high", h), ("low", l), ("close", c)):
                if v <= 0:
                    raise ValueError(f"price {name}={v} must be > 0")

        # I5 — volume is a non-negative count.
        if self.volume < 0:
            raise ValueError(f"volume {self.volume} < 0")

        return self
```

Why per-row Pydantic here and not a DataFrame check: in `transform_data` the data is *already* being turned into `R` instances for the standard model, so the invariant is **free** — it piggybacks on validation you're doing anyway. The cost only becomes a problem at *bulk* scale (§5), where you switch to a vectorized DataFrame schema.

#### The same invariants as a **vectorized** check (for bulk / DataFrame paths)

Per-row Pydantic is ~6.5× slower and ~2.5× more memory than dataclasses, and on thin data-passthrough paths *validation dominates* (the `00-theory.md` cited pathology: 120 ms → 840 ms). ([pydantic.dev performance](https://pydantic.dev/) summarized in `02-skills-and-pipeline.md`.) So for a 100k+-row batch, express the **identical** invariants as a single vectorized pass — Pandera or raw pandas — never a Python `for` loop over `df.iterrows()`.

```python
# quality/ohlc_invariants_vectorized.py
import numpy as np
import pandas as pd


def ohlc_invariant_mask(df: pd.DataFrame, value_kind: str = "price") -> pd.Series:
    """Return a boolean Series: True = row PASSES all deterministic invariants.

    Vectorized: one pass over the frame, no per-row Python. NaN-safe: a NaN in any
    OHLC column makes that row fail (notna precondition), never silently pass.
    """
    o, h, l, c, v = df["open"], df["high"], df["low"], df["close"], df["volume"]

    finite = (
        df[["open", "high", "low", "close", "volume"]]
        .apply(lambda s: np.isfinite(s))
        .all(axis=1)
    )
    lattice = (l <= np.minimum(o, c)) & (h >= np.maximum(o, c)) & (h >= l)
    vol_ok = v >= 0
    pos_ok = (
        (o > 0) & (h > 0) & (l > 0) & (c > 0) if value_kind == "price" else pd.Series(True, index=df.index)
    )
    return finite & lattice & vol_ok & pos_ok


def split_clean_quarantine(df: pd.DataFrame, value_kind: str = "price"):
    """Partition into (clean, quarantined). Quarantined rows are KEPT, not dropped."""
    mask = ohlc_invariant_mask(df, value_kind)
    clean = df[mask].copy()
    quarantine = df[~mask].copy()
    quarantine["failed_check"] = "ohlc_deterministic_invariant"
    return clean, quarantine
```

### 2.2 The "decimal shift / split not applied" check (a deterministic *bar-to-bar* sanity)

A class of GREEN-but-wrong that I1–I7 miss: a single internally-consistent bar that is off by a factor of 10/100 because a stock split wasn't applied, or a provider shifted a decimal. The bar passes OHLC consistency (it's self-consistent) but the **close-to-prior-close ratio** is impossible. This is the boundary between Layer A (per-row) and Layer B (needs the prior row), so it's a *minimal-history* deterministic check:

```python
def impossible_jump_mask(close: pd.Series, max_ratio: float = 2.0) -> pd.Series:
    """Flag a bar whose close is > max_ratio× or < 1/max_ratio× the prior close.

    A 2.0 default catches un-applied 2:1 splits / decimal shifts on liquid equities.
    Tune per asset class: crypto/illiquid micro-caps legitimately move > 100%/day, so
    raise the ratio or fall back to the statistical bound (§3) for those universes.
    """
    prev = close.shift(1)
    ratio = close / prev
    # True = SUSPICIOUS (fails). First row (prev is NaN) is exempted (ratio is NaN -> False).
    return (ratio > max_ratio) | (ratio < 1.0 / max_ratio)
```

> **Tier caveat (R-SCALE honesty).** A fixed `max_ratio` is a **Tier-1/Tier-2** heuristic: it works for liquid large-caps but produces false positives on legitimately volatile assets (crypto, penny stocks, a real limit-up move). At Tier-3 / across a heterogeneous universe, replace the fixed ratio with the **robust statistical bound** of §3, which adapts the threshold to each series' own volatility. State this in the gate's config, don't pretend the fixed ratio is universal.

### 2.3 Negative-value handling: gate by `value_kind`, never blanket-reject

A blanket "price must be > 0" is **wrong** for a financial data platform: US Treasury and Euro-area yields have been **negative**; credit/swap spreads can be negative; futures contracts (famously WTI crude in April 2020) **settled negative**. So I4 (positivity) applies **only** to `value_kind == PRICE`. A `RATE` series allows negatives; a `COUNT` series (volume, shares outstanding) must be `>= 0`. This `value_kind` discriminator is set at the **dataset** level in the catalog (a yield-curve dataset is `RATE`; an equity-OHLCV dataset is `PRICE`) and flows into the validator. Getting this wrong silently quarantines every legitimate negative-yield observation — a GREEN-source self-inflicted wound.

---

## 3. Layer B — statistical / outlier detection (post-batch quality gate)

These checks need **the rest of the series** (a window of history), so they cannot run per-row in `transform_data`. They run as a **post-batch quality gate** after the whole series for a symbol is assembled, before the bulk INSERT. They are **soft** by default — their natural verdict is **flag-and-serve** (you rarely want to withhold a number just because it's statistically unusual; a real flash-crash *is* a 6-sigma move and *is* real), escalating to quarantine only on clearly-impossible magnitudes.

### 3.1 Why a *global* mean/stddev is wrong for time series (and why outliers self-corrupt the test)

Two compounding facts make naive z-scoring useless here:

1. **Time series have temporal structure** — the mean and variance drift, so a single global mean/stddev mislabels the start/end of a trend as "outliers." The fix is a **rolling window**: *"the average and standard deviation are computed using a rolling window to account for the temporal dependency in time series."* ([towardsdatascience.com, *How to Deal with Time Series Outliers*](https://towardsdatascience.com/how-to-deal-with-time-series-outliers-28b217c7f6c2/).)
2. **Outliers contaminate the very statistics used to detect them** — *"Outliers contaminate the mean and standard deviation you use to calculate z-scores, and one extreme value pulls the mean and inflates the standard deviation."* ([Medium, *Z-Score and Modified Z-Score*](https://medium.com/@fawwazmts/z-score-and-modified-z-score-f689296e4d3a); [hausetutorials, *Use MAD instead of z-score*](https://hausetutorials.netlify.app/posts/2019-10-07-outlier-detection-with-median-absolute-deviation/).) A single 10,000% spike inflates the stddev so much that the spike itself looks "within 2σ" — the outlier hides itself.

The impact is not academic: *"a single large outlier [can] disproportionately inflate the mean and skew the representation … variance and standard deviation can become exaggerated … outliers can distort trend and seasonal components, leading to biased forecasts."* ([Magnimind Academy, *Evaluating Outlier Impact on Time Series Data Analysis*](https://magnimindacademy.com/blog/evaluating-outlier-impact-on-time-series-data-analysis/).) For a **data platform** the stakes are higher than for one analyst's model: a corrupt point we serve poisons *every* downstream consumer's mean, moving average, and forecast.

**Conclusion:** use a **rolling** window **and** a **robust** (median/MAD-based) estimator, not a global mean/stddev.

### 3.2 The outlier taxonomy — name what you're detecting

Detection method depends on the *kind* of anomaly. The standard intervention-analysis taxonomy (verified):

| Type | Definition | What it looks like | What the gate should do |
|---|---|---|---|
| **Additive Outlier (AO)** | *"an isolated spike … confined to the respective observation, after which the time series resumes its normal patterns"* — a single-point spike with **non-persistent** effect | one bad print, then back to normal | **flag the single point** (this is the bread-and-butter quality check) |
| **Level Shift (LS)** | *"changes the level or mean of the series … from a certain observation onwards … a constant which persists"* — a true change point | the series steps to a new plateau and stays | **NOT** a per-point outlier — could be a real re-basing (index methodology change, redenomination). Flag the *transition*, don't flag every post-shift point |
| **Innovational Outlier (IO)** | *"similar to additive ones but with a persistence effect … a shock in the innovations"* | a shock that decays (stationary) or persists (non-stationary) | model-dependent; for a data-quality gate, treat the onset like an AO |
| **Temporary Change (TC)** | a shock that **decays** geometrically back to the prior level | spike then exponential return | flag onset; expect recovery |

([Search synthesis of the intervention-analysis literature: PMC, *Online Conditional Outlier Detection in Nonstationary Time Series*](https://pmc.ncbi.nlm.nih.gov/articles/PMC5891145/); [DataScience+, *Outliers Detection and Intervention Analysis*](https://datascienceplus.com/outliers-detection-and-intervention-analysis/); [ResearchGate, *Detecting Level Shifts, Temporary Changes and Innovational Outliers*](https://www.researchgate.net/publication/353451505).)

> **Why the AO-vs-LS distinction is load-bearing for a data platform.** The single most dangerous false-positive is treating a **legitimate level shift** (a currency redenomination, an index methodology change, a real structural break) as a stream of outliers and quarantining all of it — you'd silently delete a true regime. Conversely, treating a **single bad print (AO)** as a level shift means you never flag it. The gate's spike detector targets **AOs**; level shifts are surfaced as a **separate, human-reviewed** signal, never auto-quarantined.

### 3.3 The robust z-score (modified z-score) — the recommended spike detector

Because the classical z-score self-corrupts (§3.1), the recommended detector is the **modified z-score** built on the **median** and **MAD** (median absolute deviation), which are robust to the very outliers we're hunting. The formulas (verified):

- **MAD:** `MAD = median(|xᵢ − median(x)|)` — *"the median of the absolute difference between a value and the median of the sample."*
- **Modified z-score:** `Mᵢ = 0.6745 · (xᵢ − median(x)) / MAD`. The constant `0.6745` is the 0.75 quantile of the standard normal, which rescales MAD onto the stddev scale so the threshold is interpretable in "sigma" units.
- **Threshold:** *"an observation is considered a potential outlier if it falls more than 3.5 MAD from the median, i.e. |Mᵢ| > 3.5."*

([Medium, *Z-Score and Modified Z-Score*](https://medium.com/@fawwazmts/z-score-and-modified-z-score-f689296e4d3a); [hausetutorials, *MAD instead of z-score*](https://hausetutorials.netlify.app/posts/2019-10-07-outlier-detection-with-median-absolute-deviation/); [CloudxLab, *Robust Z-Score Method*](https://cloudxlab.com/assessment/displayslide/6286/robust-z-score-method).)

For time series, apply it over a **rolling window** (rolling median + rolling MAD), and almost always on **returns / log-differences**, not on the raw price level — price levels trend (so a rolling median lags), whereas log-returns are roughly stationary, which is exactly what the z-test assumes:

```python
# quality/robust_outlier.py
import numpy as np
import pandas as pd


def rolling_modified_zscore(
    s: pd.Series,
    window: int = 21,        # ~1 trading month; tune per frequency
    take_log_returns: bool = True,
) -> pd.Series:
    """Rolling MODIFIED z-score (median/MAD based) — robust to the outliers it detects.

    Returns a Series of modified z-scores aligned to s. |M| > 3.5 is the conventional
    flag threshold. Operates on log-returns by default (stationary), not raw level.
    """
    x = np.log(s).diff() if take_log_returns else s

    med = x.rolling(window, min_periods=window // 2).median()
    abs_dev = (x - med).abs()
    mad = abs_dev.rolling(window, min_periods=window // 2).median()

    # 0.6745 rescales MAD to the stddev scale (0.75 quantile of N(0,1)).
    # Guard MAD==0 (a flat window) so we don't divide by zero — see §3.4 stale runs.
    mad_safe = mad.replace(0, np.nan)
    return 0.6745 * (x - med) / mad_safe


def outlier_flags(s: pd.Series, window: int = 21, threshold: float = 3.5) -> pd.Series:
    """True = the point is a candidate ADDITIVE OUTLIER (single-point spike)."""
    mz = rolling_modified_zscore(s, window=window)
    return mz.abs() > threshold
```

**Why not the classical n-moving-stddev z-score?** It is the *industry-standard convenience* (it's what `dbt-expectations`' `expect_column_values_to_be_within_n_moving_stdevs` ships, §4.3) and is fine as a **first-pass / monitoring** check, but it self-corrupts on the extreme spikes that matter most for a finance platform. **Recommendation:** use the *classical moving-stddev* bound as the cheap monitoring tripwire (it's one SQL window function), and the *robust modified z-score* as the authoritative flag when the tripwire fires. Stating both, and which is authoritative, is the senior move; shipping only the classical one and believing it catches the worst spikes is the junior one.

### 3.4 Stale-value runs (the *opposite* failure — a frozen feed)

The dual of a spike is a **flat-line**: a provider's feed freezes and ships the *same* value for N consecutive periods (a dead socket, a holiday mis-handled as a trading day, an upstream cache stuck). This is invisible to a spike detector (the variance is *too low*, not too high) and to OHLC invariants (a flat bar `o==h==l==c` is internally consistent). It is a classic GREEN-but-wrong: the number is "valid," it's just **not a real new observation**.

```python
def stale_run_flags(s: pd.Series, max_run: int = 3) -> pd.Series:
    """True = this point is part of a run of > max_run identical consecutive values.

    Detects frozen/repeated feeds. max_run tuned per series: a truly illiquid bond
    may legitimately not trade for days (so raise it), but a liquid large-cap repeating
    its close for 4 sessions is a frozen feed.
    """
    same_as_prev = s.eq(s.shift(1))
    # group consecutive identical-value runs and count their length
    run_id = (~same_as_prev).cumsum()
    run_len = same_as_prev.groupby(run_id).cumsum() + 1  # length of the run up to this point
    return run_len > max_run
```

> **Tier caveat.** `max_run` is asset-class-specific: an illiquid corporate bond legitimately prints the same evaluated price for days; a liquid index does not. Like the impossible-jump ratio, drive it from a per-dataset config, and prefer a **trading-calendar-aware** version (don't count a weekend/holiday gap as "stale") once the security-master's calendar layer exists.

### 3.5 What the statistical gate does on a hit (decision table)

| Signal | Default verdict | Escalate to quarantine when… |
|---|---|---|
| `|modified z| > 3.5` (AO candidate) | **flag-and-serve** (`quality_flag='outlier'`) — a real flash-crash is a real 6σ move | the move *also* fails the deterministic impossible-jump (§2.2) at the **price-level** ratio (e.g. > 10×) → almost certainly a decimal/split error, quarantine |
| stale run > `max_run` | **flag-and-serve** (`quality_flag='stale'`) | the run length exceeds a hard ceiling (e.g. 10× the asset's typical no-trade gap) → likely a dead feed, quarantine the run |
| level-shift detected | **flag-and-route-to-human** (`quality_flag='level_shift'`), **never auto-quarantine** | never auto-quarantine — a real re-basing must not be deleted |
| OHLC invariant fail (§2) | **quarantine** (hard) | always — a structurally impossible bar is never served |

The asymmetry is deliberate: **deterministic impossibilities quarantine; statistical surprises flag.** A finance data platform that quarantines every 4σ move silently censors exactly the days its users care about most (crashes, gaps, halts).

---

## 4. Layer C — schema-level batch validation (Pandera and/or Great Expectations)

Layers A and B are *checks*; this layer is the *framework* that runs them at batch scale, produces a structured pass/fail report, and is the natural quality-gate boundary in the write-path worker. Two libraries dominate Python; they are **complementary, not rivals** — the verified guidance is *"use Great Expectations at data product boundaries (gold tables, published datasets), and use Pandera inside the code for ETL transforms."* ([endjin, *Data validation in Python: a look into Pandera and Great Expectations*](https://endjin.com/blog/a-look-into-pandera-and-great-expectations-for-data-validation).)

### 4.1 Pandera vs Great Expectations — the decision

| Axis | **Pandera** | **Great Expectations (GX Core 1.x)** |
|---|---|---|
| Design center | *"data scientists … much simpler and more concise"* | *"production-ready validation systems that integrate with other data tools … larger and more complex"* |
| Dependencies | **12** packages | **107** packages |
| API surface | one `DataFrameSchema` / `DataFrameModel` object, `schema.validate(df)` | Data Context → Data Source → Asset → Batch Definition → Batch → Expectation Suite → `batch.validate()` |
| Where it fits | **inside** `transform_data` / the worker — code-level, unit-test-style, fast | at a **data-product boundary** — a published Distribution, a "gold" table, with persisted Data Docs (HTML) + governance |
| Statistical/time-series checks | write them as custom `Check` lambdas (full pandas power) | rich built-in expectation gallery + human-readable Validation Results |
| Engines | pandas, Polars, PySpark, Dask, Modin | pandas, Spark, SQL (SQLAlchemy) |

([endjin comparison](https://endjin.com/blog/a-look-into-pandera-and-great-expectations-for-data-validation); dependency counts quoted verbatim therein; [endjin, *Creating Quality Gates in the Medallion Architecture with Pandera*](https://endjin.com/blog/2025/04/creating-quality-gates-in-the-medallion-architecture-with-pandera).)

**Recommendation for this product line:**
- **Pandera** is the **primary, in-worker** gate (Layers A + B as a `DataFrameSchema`/`DataFrameModel` with custom `Check`s). It's 12 deps vs 107, runs inline in the Python data plane, and the standard-model `R` is already a Pydantic class so the class-based `DataFrameModel` style is idiomatic continuity. ([pandera class-based API mirrors Pydantic](https://pandera.readthedocs.io/en/stable/dataframe_models.html).)
- **Great Expectations** is the **optional, boundary** gate on a **published Parquet Distribution** — when you want persisted, human-readable Validation Results / Data Docs for a *served* data product (the catalog-visible "gold" series). Add it at the Distribution materialization step, not on every ingest row.

### 4.2 Pandera — the batch quality schema (the primary gate)

Pandera's `DataFrameSchema` declares per-column dtype/range/nullability plus DataFrame-level checks; `schema.validate(df, lazy=True)` collects **all** failures into a `SchemaErrors` rather than stopping at the first — essential for a batch gate (you want the full corruption report, not the first bad row). ([pandera DataFrameSchema](https://pandera.readthedocs.io/en/stable/dataframe_schemas.html) — constructor args `columns/checks/index/coerce/strict/unique/ordered`; `validate(df, lazy=True)` → `SchemaErrors` with `schema_errors` + `error_counts`; [pandera checks](https://pandera.readthedocs.io/en/stable/checks.html) — `Check.greater_than/ge/le/in_range/isin/...`, custom `Check(lambda s: ...)`, `element_wise`, `raise_warning`, `groupby`.)

```python
# quality/pandera_schema.py
import numpy as np
import pandas as pd
import pandera.pandas as pa
from pandera.typing.pandas import DataFrame, Series


class OhlcvQualitySchema(pa.DataFrameModel):
    """Batch quality gate for a normalized OHLCV series (class-based, Pydantic-like).

    Layer A (deterministic invariants) + Layer B (statistical) as one schema.
    """
    figi: Series[str] = pa.Field(nullable=False)
    obs_date: Series[pd.Timestamp] = pa.Field(nullable=False)

    open: Series[float] = pa.Field(gt=0, nullable=False)
    high: Series[float] = pa.Field(gt=0, nullable=False)
    low: Series[float] = pa.Field(gt=0, nullable=False)
    close: Series[float] = pa.Field(gt=0, nullable=False)
    volume: Series[float] = pa.Field(ge=0, nullable=False)

    class Config:
        # strict=True rejects unexpected columns; coerce applies dtypes; unique enforces
        # one row per (figi, obs_date) — the natural key. ordered not required.
        strict = False          # extra='allow'-style provider extras may ride along
        coerce = True
        # joint uniqueness on the natural key — duplicate bars are a corruption class
        unique = ["figi", "obs_date"]
        name = "OhlcvQualitySchema"

    # --- Layer A: OHLC lattice as a DataFrame-level check -------------------------
    @pa.dataframe_check(name="ohlc_lattice")
    def _ohlc_lattice(cls, df: pd.DataFrame) -> Series[bool]:
        # returns a boolean Series; every row must be True
        return (
            (df["low"] <= df[["open", "close"]].min(axis=1))
            & (df["high"] >= df[["open", "close"]].max(axis=1))
            & (df["high"] >= df["low"])
        )

    @pa.dataframe_check(name="finite_numerics")
    def _finite(cls, df: pd.DataFrame) -> Series[bool]:
        cols = ["open", "high", "low", "close", "volume"]
        return df[cols].apply(np.isfinite).all(axis=1)

    # --- Layer B: rolling robust outlier as a SOFT (warning) check ----------------
    @pa.dataframe_check(name="no_extreme_outlier", raise_warning=True)
    def _no_extreme_outlier(cls, df: pd.DataFrame) -> Series[bool]:
        # SOFT: raise_warning=True flags without failing the batch — a real flash-crash
        # is a real 6σ move (§3.5). The hard quarantine path uses the price-level ratio.
        from .robust_outlier import outlier_flags
        per_symbol = df.groupby("figi")["close"]
        flags = per_symbol.apply(lambda s: outlier_flags(s.reset_index(drop=True))).reset_index(drop=True)
        return ~flags.reindex(df.index).fillna(False)


def run_pandera_gate(df: pd.DataFrame):
    """Validate a batch; return (clean_df, schema_errors_or_none).

    lazy=True collects ALL failures (the full corruption report), not just the first.
    """
    try:
        validated = OhlcvQualitySchema.validate(df, lazy=True)
        return validated, None
    except pa.errors.SchemaErrors as exc:
        # exc.failure_cases is a DataFrame of every failing (check, column, value, index).
        # We DO NOT drop silently: quarantine the failing rows, keep the rest.
        failing_idx = exc.failure_cases["index"].dropna().unique()
        clean = df.drop(index=failing_idx, errors="ignore")
        quarantine = df.loc[df.index.intersection(failing_idx)].copy()
        quarantine = quarantine.merge(
            exc.failure_cases[["index", "check"]].drop_duplicates("index"),
            left_index=True, right_on="index", how="left",
        ).rename(columns={"check": "failed_check"})
        return clean, quarantine
```

Key Pandera mechanics used above, each verified:
- **`@pa.dataframe_check`** runs a check across columns, returning a boolean `Series` (every row must be `True`). ([pandera dataframe models](https://pandera.readthedocs.io/en/stable/dataframe_models.html).)
- **`raise_warning=True`** issues a *warning* instead of raising — *"allows pipeline continuation for informational checks while still flagging violations."* This is exactly the **flag-and-serve** semantics of §3.5 for statistical checks. ([pandera checks](https://pandera.readthedocs.io/en/stable/checks.html).)
- **`Config.unique = ["figi", "obs_date"]`** enforces the natural key — **duplicate bars** (a real corruption class, and the XBRL-dup analogue) fail here. ([pandera DataFrameSchema `unique` / `report_duplicates`](https://pandera.readthedocs.io/en/stable/dataframe_schemas.html).)
- **`validate(df, lazy=True)`** → `SchemaErrors.failure_cases` is the full structured report. ([pandera DataFrameSchema](https://pandera.readthedocs.io/en/stable/dataframe_schemas.html).)

> **`element_wise` warning.** Pandera's `Check(..., element_wise=True)` runs the lambda **per scalar** — that's a Python loop, the slow path. For bulk batches keep checks **vectorized** (`element_wise=False`, the default), returning a boolean Series. ([pandera checks — vectorized vs element-wise](https://pandera.readthedocs.io/en/stable/checks.html).) This mirrors the Pydantic-per-row-vs-vectorized tradeoff of §2.1.

### 4.3 Great Expectations — the boundary gate (modern GX Core 1.x)

When you publish a **Distribution** as a served data product, GX gives persisted, human-readable Validation Results. The modern (1.x) API is *not* the old `expectation_suite.yml` flow — it's the fluent `get_context → data_sources.add_pandas → add_dataframe_asset → add_batch_definition_whole_dataframe → get_batch → batch.validate(...)` chain. ([docs.greatexpectations.io, *Try GX Core*](https://docs.greatexpectations.io/docs/core/introduction/try_gx/) — full method names verified.)

```python
# quality/gx_boundary_gate.py
import great_expectations as gx
import pandas as pd


def gx_validate_distribution(df: pd.DataFrame):
    context = gx.get_context()

    data_source = context.data_sources.add_pandas("ohlcv_pandas")
    data_asset = data_source.add_dataframe_asset(name="ohlcv_distribution")
    batch_definition = data_asset.add_batch_definition_whole_dataframe("whole_df")
    batch = batch_definition.get_batch(batch_parameters={"dataframe": df})

    suite = gx.ExpectationSuite(name="ohlcv_quality")
    # deterministic-range expectations (Layer A, framework form)
    suite.add_expectation(gx.expectations.ExpectColumnValuesToBeBetween(
        column="close", min_value=0, strict_min=True))          # price > 0
    suite.add_expectation(gx.expectations.ExpectColumnValuesToBeBetween(
        column="volume", min_value=0))                          # volume >= 0
    suite.add_expectation(gx.expectations.ExpectColumnValuesToNotBeNull(column="close"))
    suite.add_expectation(gx.expectations.ExpectColumnValuesToBeUnique(column="obs_date"))
    # mostly: tolerate a small bad-fraction without failing the whole suite
    suite.add_expectation(gx.expectations.ExpectColumnValuesToBeBetween(
        column="high", min_value=0, strict_min=True, mostly=0.999))

    result = batch.validate(suite)
    return result  # result.success is the overall pass/fail; per-expectation detail inside
```

- **`ExpectColumnValuesToBeBetween(min_value, max_value, strict_min, strict_max, mostly)`** — `mostly` sets the **fraction of rows** that must pass for the expectation to succeed (e.g. `mostly=0.999` tolerates ≤ 0.1% bad rows). This is GX's built-in **flag-vs-fail tolerance**, the framework analogue of `raise_warning`. ([greatexpectations.io, ExpectColumnValuesToBeBetween](https://greatexpectations.io/expectations/expect_column_values_to_be_between/); [docs.greatexpectations.io row conditions / try_gx](https://docs.greatexpectations.io/docs/core/introduction/try_gx/).)

> **CRITICAL accuracy note — `expect_column_values_to_be_within_n_moving_stdevs` is NOT a native Great Expectations expectation.** It is a **`dbt-expectations`** (calogica) **dbt test macro**, a SQL-side port. Do not write `gx.expectations.ExpectColumnValuesToBeWithinNMovingStdevs(...)` — it does not exist in GX Core. ([Verified: the macro lives at calogica/dbt-expectations and is *"a port(ish) of Great Expectations to dbt test macros"*](https://github.com/calogica/dbt-expectations); [elementary-data dbt test hub](https://www.elementary-data.com/dbt-tests/expect-column-values-to-be-within-n-moving-stdevs).) Two correct ways to get the moving-stdev check: **(a)** implement it as the Pandera/pandas rolling check of §3.3/§4.4; **(b)** if your store is SQL (TimescaleDB) and you run dbt over it, use the dbt-expectations macro directly. Use the robust modified-z (§3.3) as the authoritative version regardless.

### 4.4 The `dbt-expectations` moving-stdevs macro (the SQL-side option, exact semantics)

If the warehouse path runs dbt over TimescaleDB, the canonical SQL implementation is the calogica macro — useful because its formula is the *exact* "n-moving-stdevs" definition and its parameter defaults are a sane starting point. Verified parameters and defaults:

| Parameter | Default | Meaning |
|---|---|---|
| `date_column_name` | — | the time column for ordering |
| `period` | `'day'` | time bucket unit |
| `lookback_periods` | `1` | lag for the prior-value comparison |
| `trend_periods` | `7` | window size for the rolling avg/stddev |
| `test_periods` | `14` | how far back the test evaluates |
| `sigma_threshold` | `3` | ± z-score bound (or split into `sigma_threshold_upper/lower`) |
| `take_logs` | — | apply natural-log transform (use for multiplicative/price series) |
| `group_by` | — | segment by dimension(s) |

([elementary-data dbt test hub](https://www.elementary-data.com/dbt-tests/expect-column-values-to-be-within-n-moving-stdevs); defaults from the macro and the dbt-expectations integration tests.) The exact SQL (verified from the macro source):

```sql
-- moving average over the PRECEDING trend_periods window (excludes the current row)
avg(metric_test_value)    over (partition by ... order by metric_period
                                rows between {trend_periods} preceding and 1 preceding)
stddev(metric_test_value) over (partition by ... order by metric_period
                                rows between {trend_periods} preceding and 1 preceding)
-- sigma (z-score), guarding a zero rolling stddev
sigma = (metric_test_value - rolling_average) / nullif(rolling_stddev, 0)
-- FAILURE when sigma falls OUTSIDE the band:
NOT (sigma >= sigma_threshold_lower AND sigma <= sigma_threshold_upper)
```

([github.com/calogica/dbt-expectations — `expect_column_values_to_be_within_n_moving_stdevs.sql`](https://github.com/calogica/dbt-expectations/blob/main/macros/schema_tests/distributional/expect_column_values_to_be_within_n_moving_stdevs.sql).) Note two design choices baked in: the window is **`rows between N preceding and 1 preceding`** — it **excludes the current row** so the point can't smooth away its own anomaly, and **`nullif(stddev, 0)`** guards the **flat-window / stale-run** divide-by-zero (the §3.4 case). This is the *classical* (non-robust) z, so treat it as the monitoring tripwire, not the authoritative spike call (§3.3).

### 4.5 Row-count / freshness / uniqueness drift (table-level batch checks)

Beyond per-value checks, a batch has **table-level** quality signals — these catch a *truncated* feed or a *stuck* loader that per-row checks miss entirely:

| Check | Detects | Pandera / GX form |
|---|---|---|
| **Row-count drift** | a series that returns 30 rows today vs ~250 typical → upstream truncation | compare `len(df)` to a rolling baseline; GX `ExpectTableRowCountToBeBetween`; dbt-expectations `expect_table_row_count_to_be_within_n_stdevs` |
| **Recency / freshness** | the latest `obs_date` is stale (no new data) → dead loader | `df["obs_date"].max() >= expected_as_of`; dbt-expectations `expect_row_values_to_have_recent_data` |
| **Uniqueness / dup key** | two rows for the same `(figi, obs_date)` → the XBRL-dup analogue | Pandera `Config.unique`; GX `ExpectCompoundColumnsToBeUnique` |
| **Null-rate drift** | a column that's suddenly 40% null → schema change upstream | GX `ExpectColumnValuesToNotBeNull(mostly=...)` |

([dbt-expectations sibling tests — row-count and recency macros, calogica repo](https://github.com/calogica/dbt-expectations); GX expectation names from the gallery / try_gx.) These belong in the **post-batch** gate (Layer C), because they're properties of the *whole pull*, not of one row.

---

## 5. Cross-source reconciliation — two providers disagree (flag, don't average)

When the catalog has **two GREEN providers for the same logical series** (the security master makes this possible — that's its whole point), a powerful quality check falls out for free: **fetch both, compare, and if they disagree beyond tolerance, FLAG — never silently average them.** Averaging two disagreeing sources **invents a third number that neither provider published** — a textbook "never invent a finance number" violation, and it *hides* the discrepancy instead of surfacing it.

### 5.1 The reconciliation algorithm

```python
# quality/reconcile.py
import numpy as np
import pandas as pd


def reconcile_two_sources(
    a: pd.DataFrame,           # provider A, indexed by (figi, obs_date), column 'close'
    b: pd.DataFrame,           # provider B, same index
    rel_tol: float = 0.005,    # 0.5% relative tolerance (tune per asset/frequency)
    abs_tol: float = 1e-6,
) -> pd.DataFrame:
    """Join two providers on the natural key; flag rows that disagree beyond tolerance.

    Returns a frame with both values, the relative diff, and an `agree` flag.
    Rows where one source is missing are flagged 'coverage_gap', NOT filled from the other
    silently — coverage differences are a real signal, not noise to paper over.
    """
    joined = a[["close"]].join(b[["close"]], how="outer", lsuffix="_a", rsuffix="_b")
    both = joined["close_a"].notna() & joined["close_b"].notna()

    rel_diff = (joined["close_a"] - joined["close_b"]).abs() / joined[["close_a", "close_b"]].abs().max(axis=1)
    agree = both & np.isclose(joined["close_a"], joined["close_b"], rtol=rel_tol, atol=abs_tol)

    joined["rel_diff"] = rel_diff
    joined["status"] = np.select(
        [~both, both & ~agree, both & agree],
        ["coverage_gap", "DISAGREE", "agree"],
        default="unknown",
    )
    return joined
```

### 5.2 What a disagreement *means* and what the gate does

| Status | Likely cause | Gate action |
|---|---|---|
| `agree` | both providers concur within tolerance | serve; this is *positive* evidence of correctness (corroboration) |
| `DISAGREE` | adjustment difference (split/dividend applied by one not the other), a corporate action timing mismatch, or one source is wrong | **flag** (`quality_flag='source_disagreement'`), pick the **designated primary** source's value, and record *both* in provenance — **never average** |
| `coverage_gap` | one provider doesn't cover this instrument/date | flag `coverage_gap`; serve the covering source; **do not** treat the gap as agreement |

> **Why "pick the primary, never average."** Reconciliation is a *cross-check*, not a *blend*. If A and B disagree, exactly one (or both) is wrong, and the value users need is a *real published number* with a known provenance — not a synthetic midpoint. The platform's value is **knowing which source you're looking at and that it's grounded**, which is destroyed the moment you emit an un-sourced average. The disagreement itself is a high-value catalog signal: a series with frequent source disagreement is *lower quality* and the catalog can rank/flag it accordingly. This is the §1 "ground and validate" rule applied across providers, and it ties directly to the theory doc's security-master falsifiability test (*"ingest the same instrument from two providers … if the catalog cannot return a single joined series for it, the security master is not real"*). Reconciliation is what you *do* once that join works.

> **Adjustment caveat (the most common false DISAGREE).** The #1 source of spurious disagreement is **adjusted vs unadjusted** close (one provider applies split/dividend adjustments, the other doesn't). Reconcile **like-for-like**: compare *unadjusted* close to *unadjusted* close, or normalize both to the same adjustment basis first. Comparing adjusted-A to unadjusted-B will flag every historical date before the most recent corporate action — a wall of false positives. State the adjustment basis in provenance and reconcile within-basis.

---

## 6. Where each check runs — the placement contract

The single most important architecture decision is **which gate runs where**, because it determines cost and what a failure can do. The rule: **cheap deterministic invariants run inline (transform stage); expensive statistical/cross-source checks run as a post-batch gate before persist.**

```
WRITE PATH (Fly worker, off the request path — never on a user request)
────────────────────────────────────────────────────────────────────────
  transform_query → aextract_data → transform_data ──────────────► (assembled batch) ──► PERSIST
                                         │                                  │
                                         ▼                                  ▼
                              ┌──────────────────────┐         ┌──────────────────────────────┐
                              │ LAYER A (inline)     │         │ LAYER B + C (post-batch gate)│
                              │ per-row, O(1):       │         │ needs history / whole batch: │
                              │ • OHLC invariants    │         │ • rolling robust z (outliers)│
                              │ • non-negativity     │         │ • stale-run detection        │
                              │ • finite (no NaN/Inf)│         │ • row-count / recency drift  │
                              │ • impossible jump    │         │ • cross-source reconcile (§5)│
                              │   (minimal history)  │         │ • Pandera/GX batch schema    │
                              │ → reject row → quar. │         │ → flag-and-serve OR quar.    │
                              └──────────────────────┘         └──────────────────────────────┘
                                         │                                  │
                                         └──────────┐            ┌──────────┘
                                                    ▼            ▼
                                       clean rows ──► TimescaleDB store + Parquet Distribution
                                       failed rows ─► *_quarantine table / quarantine/ Parquet path
                                                      (KEPT for audit + re-process, NOT served)
```

**Placement rules:**
1. **Layer A inline** — runs in `transform_data` as the Pydantic `R` `model_validator` (or the vectorized mask for bulk). A structurally impossible bar dies before it joins the batch. Reject → quarantine.
2. **Layer B + C post-batch** — runs **after** the full series for a symbol is assembled, **before** the INSERT. These need a window/whole-batch and can't be per-row. Default verdict **flag-and-serve**; hard-impossible escalates to quarantine.
3. **Reconciliation (§5)** — runs when ≥2 providers cover the series; it's a Layer-C cross-batch check (needs both providers' batches).
4. **Everything is off the request path.** This whole gate lives in the **worker/cron write path** (repo non-negotiable #4: no sockets/timers/heavy work on the serverless route). The read path *never* validates — it serves already-validated bytes from the store. ([`product-at-scale.md`](../../../.claude/rules/product-at-scale.md): *"Heavy ingest … lives in `worker/` on a cron, not the serverless route."*)
5. **Quarantine is durable.** Failed rows go to a parallel quarantine store with `failed_check` + the raw values, so corruption is **auditable and re-processable**, never lost. A re-run after a provider fixes the upstream can re-validate quarantined rows.

### 6.1 The orchestration glue (the gate as one function)

```python
# quality/gate.py — the single quality gate called by the write-path worker
import pandas as pd

from .pandera_schema import run_pandera_gate
from .robust_outlier import outlier_flags
from .stale import stale_run_flags  # the §3.4 function, in its own module


def quality_gate(df: pd.DataFrame, *, value_kind: str = "price") -> dict:
    """Run the full quality gate on an assembled, already-normalized batch.

    Returns {'clean': df, 'quarantine': df, 'flags': df} — clean is served,
    quarantine is kept-not-served, flags is served-with-quality_flag.
    NEVER drops silently; NEVER backfills a fabricated value.
    """
    # Layer A + C deterministic/schema (hard): Pandera quarantines structural failures.
    clean, quarantine = run_pandera_gate(df)
    if quarantine is None:
        quarantine = df.iloc[0:0].copy()

    # Layer B statistical (soft): annotate quality_flag, keep serving.
    clean = clean.copy()
    clean["quality_flag"] = ""
    for figi, g in clean.groupby("figi"):
        s = g.sort_values("obs_date")["close"].reset_index(drop=True)
        out = outlier_flags(s).reindex(range(len(g))).fillna(False).to_numpy()
        stale = stale_run_flags(s).reindex(range(len(g))).fillna(False).to_numpy()
        idx = g.sort_values("obs_date").index
        clean.loc[idx[out], "quality_flag"] = "outlier"
        clean.loc[idx[stale], "quality_flag"] = "stale"

    flags = clean[clean["quality_flag"] != ""].copy()
    return {"clean": clean, "quarantine": quarantine, "flags": flags}
```

---

## 7. Tuning, calendars, and the honest tier statement (R-SCALE)

A quality gate is only as good as its thresholds, and **a fixed threshold is a Tier-1/Tier-2 artifact**. State plainly where the gate is and what breaks next:

| Knob | Tier-1 (demo) | Tier-2/3 (production) | Why it must evolve |
|---|---|---|---|
| outlier threshold | fixed `|z| > 3.5` global | per-asset-class, per-frequency; modified-z over a rolling window | one threshold over-flags crypto, under-flags treasuries |
| impossible-jump ratio | fixed `2.0×` | per-asset; statistical bound for volatile universes | penny stocks/crypto legitimately > 100%/day |
| stale `max_run` | fixed `3` | **trading-calendar-aware**, per-liquidity | illiquid bonds don't trade daily; holidays aren't staleness |
| reconciliation tol | fixed `0.5%` | per-asset, like-for-like adjustment basis | FX vs micro-cap need different tolerances |
| row-count drift | none | rolling baseline per series | a truncated feed is invisible without a baseline |

**The trading-calendar dependency.** Stale-run and recency checks are *wrong* without a market calendar: a weekend, a holiday, or a half-day is **not** staleness, and an exchange that's closed today shouldn't trip "no recent data." These checks should consume the **security-master's calendar layer** (the same subsystem that resolves identity also knows each instrument's exchange calendar). Until that exists, a naive "every N consecutive identical values" gate **will** false-positive across weekends — flag this as a known Tier-1 limitation, don't pretend it's calendar-aware.

**Honest tier statement for this gate (the R-SCALE writeup the rule demands):**
- **Layer A (deterministic invariants)** survives **Tier-3** as-is — it's O(1)-per-row, vectorized, calendar-independent, and the invariants are universal.
- **Layer B (statistical)** survives **Tier-2** with fixed thresholds; at **Tier-3** it needs per-asset-class config + a trading calendar or it over/under-flags. The *mechanism* (rolling modified-z, stale-run) is correct at all tiers; only the *thresholds* are tier-bound.
- **Layer C (Pandera/GX batch)** survives **Tier-3** for Pandera (vectorized, in-process); GX is a **boundary**-only gate (don't run its 107-dep machinery on every ingest at scale — reserve it for published Distributions).
- **What breaks at the next tier if ignored:** a fixed global threshold + no calendar → a flood of false-positive flags at Tier-3 that trains operators to ignore the gate (alert fatigue = the gate is now decorative). The fix is config-per-dataset + calendar, named here so it isn't "discovered" in an incident.

---

## 8. Anti-patterns (mistake → fix) — the red-team's quality-gate hit list

| Anti-pattern | Why it's wrong | Fix |
|---|---|---|
| **Silently dropping failing rows** to make the batch "look complete" | hides corruption; the `00-theory.md` "look complete" instinct applied to bad rows | **quarantine** (keep, don't serve); never `df = df[mask]` without persisting the dropped rows + reason |
| **Backfilling / interpolating a bad value on the write path** | **invents a finance number** (non-negotiable #1) | quarantine the row; gapfill/`locf` is a **read-path, labelled** affordance only, never a silent write repair |
| **Averaging two disagreeing sources** | emits a number neither provider published — invents a number, hides the discrepancy | **flag**, pick the designated primary, record both in provenance (§5) |
| **Global mean/stddev z-score on a trending series** | mislabels trend start/end as outliers; the outlier self-inflates the stddev and hides | **rolling window** + **robust** modified-z (median/MAD) (§3.3) |
| **`try/except: pass` around `schema.validate`** | a corrupt batch persists; the swallowed-error tell | let it raise or use `lazy=True` and route failures to quarantine explicitly |
| **`high >= low` without a NaN precondition** | `NaN >= x` is `False` in pandas — polarity bugs let `NaN` bars through | assert `np.isfinite` / `notna` **first** (I7, §2.1) |
| **Blanket `price > 0` on a yields/spreads dataset** | negative yields/spreads/WTI-2020 are real; silently quarantines valid data | gate positivity by `value_kind` (§2.3) |
| **Per-row Pydantic on a 1M-row bulk path** | the 120 ms→840 ms validation-dominates pathology | vectorized Pandera/pandas mask for bulk; per-row Pydantic only on streaming/small `transform_data` (§2.1, §5) |
| **`gx.expectations.ExpectColumnValuesToBeWithinNMovingStdevs(...)`** | **does not exist** — it's a `dbt-expectations` SQL macro, not a GX expectation | implement the rolling check in Pandera/pandas (§3.3) or use the dbt macro on the SQL store (§4.4) |
| **`element_wise=True` Pandera checks on bulk** | runs the lambda per scalar — a Python loop | keep checks vectorized (boolean-Series return), the default |
| **Stale-run / recency check with no trading calendar** | weekends/holidays read as "stale"/"no recent data" → false positives | consume the security-master calendar; flag the limitation until it exists (§7) |
| **Running the quality gate on the read/serverless path** | heavy stats + history on a stateless function; violates non-negotiable #4 | the gate is **write-path/worker only**; reads serve validated bytes from the store (§6) |
| **Treating a level shift (real re-basing) as a run of outliers** | silently deletes a true regime change (redenomination, index methodology) | route level-shifts to human review, never auto-quarantine (§3.2/§3.5) |
| **Quarantining every statistical outlier (hard fail)** | censors flash-crashes/gaps — exactly the days users care about | statistical = **flag-and-serve** by default; only deterministic-impossible = quarantine (§3.5) |

---

## 9. Output contract — how a reviewer grades a quality-gate implementation

A correct quality gate for this product line must demonstrate, in code, all of:

1. **Three separate gates kept separate** — license (`commercialOk`), shape (Pydantic `R`), quality (this doc). The quality gate does **not** re-decide licensing or shape; it answers only "is this number plausibly real?" (§1).
2. **Layer A inline + Layers B/C post-batch** — deterministic O(1) invariants in `transform_data`; statistical/cross-source as a post-batch gate before persist. Placement matches §6, all on the worker write path.
3. **OHLC invariants, NaN-safe** — `low ≤ min(o,c)`, `high ≥ max(o,c)`, `high ≥ low`, finite-precondition first, positivity gated by `value_kind` (§2).
4. **Robust + rolling statistics** — modified z-score (median/MAD) over a rolling window on log-returns, not a global classical z; stale-run + impossible-jump as named checks; AO-vs-LS distinction respected (§3).
5. **Pandera primary, GX boundary** — batch schema in Pandera with `lazy=True` + `dataframe_check` + `unique` natural key; GX reserved for published Distributions; the `within_n_moving_stdevs` provenance correctly attributed to dbt-expectations (§4).
6. **Cross-source reconciliation flags, never averages** — pick primary + record both, like-for-like adjustment basis (§5).
7. **Failure semantics are quarantine / flag-and-serve / typed-unavailable — never silent-drop, never backfill** — the cardinal rule of §1, enforced in the gate function (§6.1).
8. **Honest R-SCALE tier statement** — which thresholds are tier-bound, the trading-calendar dependency named, what breaks at the next tier (§7).
9. **Every concrete library claim cited** — Pandera/GX/dbt-expectations API names and the statistical formulas are primary-sourced, and the "not a native GX expectation" trap is called out, not silently wrong (§4.3).

A gate that passes shape + license but ships a high-below-low bar, a 10,000% un-split jump, a frozen feed, or a silently-averaged source has **failed "ground and validate"** and re-opens the exact GREEN-but-wrong hole this doc exists to close.

---

## References (primary sources read for this doc)

- **Pandera** — DataFrameSchema/Column/validate/lazy: [pandera.readthedocs.io/en/stable/dataframe_schemas.html](https://pandera.readthedocs.io/en/stable/dataframe_schemas.html) · Check API (built-ins, custom, `element_wise`, `raise_warning`, `groupby`): [pandera.readthedocs.io/en/stable/checks.html](https://pandera.readthedocs.io/en/stable/checks.html) · class-based DataFrameModel + `@dataframe_check`/`@check`/`Field`/`Config`/`@check_types`: [pandera.readthedocs.io/en/stable/dataframe_models.html](https://pandera.readthedocs.io/en/stable/dataframe_models.html)
- **Great Expectations** — modern GX Core 1.x fluent API (get_context → data_sources.add_pandas → add_dataframe_asset → add_batch_definition_whole_dataframe → get_batch → batch.validate): [docs.greatexpectations.io/docs/core/introduction/try_gx](https://docs.greatexpectations.io/docs/core/introduction/try_gx/) · ExpectColumnValuesToBeBetween (`min_value/max_value/strict_min/strict_max/mostly`): [greatexpectations.io/expectations/expect_column_values_to_be_between](https://greatexpectations.io/expectations/expect_column_values_to_be_between/)
- **Pandera vs GX comparison + quality gates** — dependency counts (12 vs 107), "use GX at boundaries, Pandera in code": [endjin.com/blog/a-look-into-pandera-and-great-expectations-for-data-validation](https://endjin.com/blog/a-look-into-pandera-and-great-expectations-for-data-validation) · [endjin.com/blog/2025/04/creating-quality-gates-in-the-medallion-architecture-with-pandera](https://endjin.com/blog/2025/04/creating-quality-gates-in-the-medallion-architecture-with-pandera)
- **dbt-expectations moving-stdevs macro** — exact SQL + params/defaults; "port(ish) of Great Expectations to dbt test macros" (i.e. NOT a native GX expectation): [github.com/calogica/dbt-expectations](https://github.com/calogica/dbt-expectations) · [.../expect_column_values_to_be_within_n_moving_stdevs.sql](https://github.com/calogica/dbt-expectations/blob/main/macros/schema_tests/distributional/expect_column_values_to_be_within_n_moving_stdevs.sql) · [elementary-data.com/dbt-tests/expect-column-values-to-be-within-n-moving-stdevs](https://www.elementary-data.com/dbt-tests/expect-column-values-to-be-within-n-moving-stdevs)
- **Outlier taxonomy (AO/LS/IO/TC)** — [PMC, Online Conditional Outlier Detection in Nonstationary Time Series](https://pmc.ncbi.nlm.nih.gov/articles/PMC5891145/) · [DataScience+, Outliers Detection and Intervention Analysis](https://datascienceplus.com/outliers-detection-and-intervention-analysis/) · [ResearchGate, Detecting Level Shifts, Temporary Changes and Innovational Outliers](https://www.researchgate.net/publication/353451505)
- **Robust z / MAD + rolling windows** — [Medium, Z-Score and Modified Z-Score](https://medium.com/@fawwazmts/z-score-and-modified-z-score-f689296e4d3a) · [hausetutorials, Use MAD instead of z-score](https://hausetutorials.netlify.app/posts/2019-10-07-outlier-detection-with-median-absolute-deviation/) · [CloudxLab, Robust Z-Score Method](https://cloudxlab.com/assessment/displayslide/6286/robust-z-score-method) · [towardsdatascience, How to Deal with Time Series Outliers](https://towardsdatascience.com/how-to-deal-with-time-series-outliers-28b217c7f6c2/)
- **Outlier impact on time-series analysis** — [Magnimind Academy, Evaluating Outlier Impact on Time Series Data Analysis](https://magnimindacademy.com/blog/evaluating-outlier-impact-on-time-series-data-analysis/)
- **OHLC consistency rule** — `low ≤ min(open,close)`, `high ≥ max(open,close)`: [domo.com OHLC guide](https://www.domo.com/learn/charts/ohlc-chart) · [Wikipedia, Open-high-low-close chart](https://en.wikipedia.org/wiki/Open-high-low-close_chart)
- **Pydantic v2 validators** — `@model_validator(mode='after')` (instance method → `Self`, raise `ValueError`), `@field_validator`: [pydantic.dev/docs/validation/latest/concepts/validators](https://pydantic.dev/docs/validation/latest/concepts/validators/)
- **Project anchors** — GREEN-but-wrong / "ground and validate": [`00-theory.md`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/00-theory.md), [`02-skills-and-pipeline.md`](../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md) · [`commercial-ok-gate.md`](../../../.claude/rules/commercial-ok-gate.md) · [`product-at-scale.md`](../../../.claude/rules/product-at-scale.md)
