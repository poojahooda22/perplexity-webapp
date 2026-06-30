# patterns · The batch-file bundle: Parquet/CSV files, partitioning, the manifest, checksums, compression

> **Product line.** This reference belongs to the **`dataquery-delivery-channels` dev-skill** of the
> **JPM-Markets re-engineering data-analytics product line — NOT Lumina**. That line is a *separate*
> product (the DataQuery / Fusion re-engineering, the **Distribution Layer** project), built on a **new
> Python / FastAPI / data-engineering stack**, not Lumina's Bun + Express + Prisma + Supabase + Upstash
> stack. Nothing here is wired into Lumina's runtime; the two repos only share a filesystem home for the
> research ([`cto-rules.md`](../../../rules/cto-rules.md) §"Scope note").
>
> **What this doc is.** The concrete build recipe for the **artifacts of the batch/file delivery
> channel** — the actual bytes that land in the client's bucket when they request a bulk export instead
> of a live API call. It is the file-format half of the distribution layer's "many taps over one core"
> ([`distribution-mcp-channel/00-theory.md`](../../../../.agents/jpm-markets-reengineering/distribution-mcp-channel/00-theory.md)
> §"What we are building"): the **Fusion "Distribution"** — *"downloadable instances of a dataset,
> containing a file type, such as CSV or Parquet"*
> ([JPMorgan Fusion docs](https://jpmorganchase.github.io/fusion/4.0.3/)). This doc specifies exactly
> what goes in that bundle and how it is laid out, named, compressed, checksummed, and described by a
> manifest.
>
> **The one rule this whole doc enforces.** **The bundle carries the `commercialOk` verdict at FILE
> granularity, and a bulk export can never launder a RED series.** A batch file is the single biggest
> licensing-leak surface in the whole product: an API call returns one series a human can reason about; a
> tar of 4,000 Parquet files leaving for a client's S3 bucket is exactly where a RED series rides out
> unnoticed. Every file in the manifest carries its own `commercialOk` + `attribution`, and the export
> assembler refuses to bundle a non-GREEN file into a `commercialOk:true` distribution
> ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md);
> [`data-normalization-tet/patterns-provenance-stamping.md`](../../../skills/data-normalization-tet/references/patterns-provenance-stamping.md)
> §5 contamination rule).

---

## 0. The thirty-second answer (read this first)

When a client requests a **bulk export** of a dataset (a date range of one or many series), the worker
produces a **bundle**: a directory tree of data files plus exactly one **manifest JSON** that describes
them. The recipe:

1. **Format: Parquet by default, CSV on request.** Parquet is columnar, typed, compressed, and is *the*
   Fusion Distribution format for "large data querying needs"
   ([Fusion docs](https://jpmorganchase.github.io/fusion/4.0.3/)). CSV exists only because business users
   and old ETL ask for it — it is untyped, larger, and slower, so it is opt-in, never the default. Write
   Parquet with **pyarrow `pq.write_table` / `pq.write_to_dataset`** (Arrow 24.0.0).
2. **Partition by date (and dataset) in Hive directory layout.** A date-partitioned series feed is laid
   out `root/dataset=<id>/dt=YYYY-MM-DD/part-*.parquet` so a consumer (and our own re-ingest) can prune
   to the dates they need without reading the whole feed
   ([Arrow Hive partitioning](https://arrow.apache.org/docs/python/dataset.html)).
3. **Compress: zstd for Parquet, gzip for CSV.** zstd gives Gzip-class ratios at Snappy-class decompress
   speed and is the modern data-lake default (Iceberg already defaults Parquet to zstd)
   ([e6data](https://www.e6data.com/blog/fast-writes-apache-iceberg-snappy-vs-zstd)). Use **Snappy** only
   when the consumer's reader is latency-bound on decompress and storage is free.
4. **Checksum every file with SHA-256.** The manifest carries `sha256` + `bytes` + `rows` per file. The
   checksum is the **idempotency key**: a re-run that produces a byte-identical file is a no-op for the
   consumer, and a corrupted transfer is caught before ingest
   ([Salesforce Data 360 file fingerprinting](https://architect.salesforce.com/docs/architect/fundamentals/guide/data360_integration_patterns_and_practices);
   [Openbridge MD5/SHA validation](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices)).
5. **One manifest per run, named `manifest-<destinationId>-<runId>.json`.** It lists every file with its
   `rows`, `bytes`, `sha256`, `format`, `dataset`, `series_ids`, `commercialOk`, `attribution`, `asOf` —
   plus run-level `run_id`, `generated_at`, `schema_version`, `total_rows`. This is the Adobe Experience
   Platform manifest convention, extended with our provenance fields
   ([Adobe AEP manifest](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/cloud-storage/data-landing-zone)).
6. **Schema stability is additive-only.** Adding a nullable column is safe (old files read back NULL);
   **renaming or reordering a column is breaking** because Parquet/CSV resolve columns by *name/position*
   ([Parquet schema evolution](https://pola.rs/posts/schema-evolution/)). A rename is a new
   `schema_version` and a deprecation cycle, never an in-place edit.

If that paragraph is all you needed, stop here. The rest is the format decision in depth, the
partitioning layout, the exact manifest schema + Pydantic model, the checksum/idempotency mechanics, the
compression decision table, the schema-stability contract, the per-file `commercialOk` gate, and the
runnable pyarrow writer + manifest emitter that runs on the worker.

---

## 1. Format choice — Parquet (default) vs CSV (on request)

### 1.1 The decision, stated once

| | **Parquet** (default) | **CSV** (opt-in) |
|---|---|---|
| Layout | columnar (column-major) | row-major text |
| Types | **typed** — int64/float64/decimal/timestamp/string preserved in the footer | **untyped** — everything is text; the reader re-infers |
| Size on disk | small (encoded + compressed; dictionary + RLE + delta encodings) | large (decimal `4.27000000` is 10 bytes of text) |
| Column-prune read | yes — read only the columns you need | no — must scan every row fully |
| Predicate pushdown | yes — row-group min/max stats skip whole groups | no |
| Human-readable | no (binary) | yes (open in a text editor / Excel) |
| Interop with legacy ETL | needs an Arrow/Spark/pandas reader | universal |
| Self-describing schema | **yes** — schema is in the footer | no — header row only, types lost |
| Our use | **the default Fusion Distribution** | only when the client explicitly asks |

The rule: **Parquet is the default; CSV is a conversion we offer because some consumers demand it.** This
is exactly the Fusion stance — *"data formats are conformed to both CSV for business users and Parquet
for large data querying needs"*
([Fusion docs](https://jpmorganchase.github.io/fusion/4.0.3/)) — and the AEP destination stance, which
offers CSV / JSON / Parquet as selectable file types
([AEP file-based destinations](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/api/activate-segments-file-based-destinations)).

### 1.2 Why Parquet is the right default (first-principles, not cargo-cult)

A market-data export is **tall and narrow and repetitive**: millions of rows, a handful of columns
(`ts`, `instrument_id`, `value`, maybe OHLCV), and within a column the values are highly similar
(adjacent timestamps differ by one bar; adjacent prices by pennies). Columnar storage wins on exactly
this shape for three compounding reasons:

1. **Encoding before compression.** Parquet encodes each column with dictionary, run-length (RLE), and
   delta encodings *before* the compression codec runs. A column of 1M timestamps one minute apart
   delta-encodes to ~1M copies of the integer `60`, which RLE collapses to almost nothing. CSV cannot do
   this — every timestamp is re-spelled in full text. The footer also carries **column statistics**
   (min/max/null_count per column per row group) so a reader skips row groups that can't match a
   predicate without decoding them
   ([Parquet metadata/statistics](https://www.mungingdata.com/pyarrow/parquet-metadata-min-max-statistics/);
   [Dremio "All About Parquet" Pt.7](https://medium.com/data-engineering-with-dremio/all-about-parquet-part-07-metadata-in-parquet-improving-data-efficiency-9a613b099fb7)).

2. **Types survive the round trip.** The footer stores `timestamp[us, tz=UTC]`, `decimal128(18,8)`,
   `int64` — so a `4.27` yield comes back as a `Decimal`, not a string the consumer must re-parse and
   possibly mis-round. This is load-bearing for *our* product specifically: the normalization layer
   already fought the "is this 4.27% or 0.0427?" unit war
   ([`data-normalization-tet/patterns-provenance-stamping.md`](../../../skills/data-normalization-tet/references/patterns-provenance-stamping.md)
   §4.3), and CSV would throw that work away at the file boundary. **Parquet preserves the unit-of-measure
   contract; CSV launders it back into ambiguous text.**

3. **Column pruning + predicate pushdown.** A consumer who wants only `close` for `^GSPC` reads one
   column of one row group, not the whole file. The reader *"always starts by reading the last 8 bytes of
   the file to find the footer length, then reads the footer to learn the schema, row group locations,
   and column statistics"*
   ([viewparquet FAQ](https://viewparquet.com/parquet-faq)) — so it knows what to skip before touching a
   data page.

### 1.3 When CSV is the right call (and its traps)

CSV is correct when: the consumer is a human opening it in Excel; a legacy ETL tool with no Arrow/Spark
reader; or a tiny export where interop beats efficiency. Its traps, which the writer must defend against:

- **Type loss.** `decimal128(18,8)` → text. Document in the manifest's `format: "csv"` that types are
  not preserved; the consumer re-infers from the header.
- **Quoting & embedded delimiters.** A string field containing a comma or newline must be quoted or the
  file is unparseable. Use pyarrow's `quoting_style="needed"` (quote only when required) and **never**
  `"none"` (which *raises* on a special character)
  ([pyarrow `WriteOptions`](https://arrow.apache.org/docs/python/generated/pyarrow.csv.WriteOptions.html)).
- **Header presence.** Always write the header (`include_header=True`) — it is the only schema CSV has.
- **Encoding.** UTF-8, no BOM, `\n` line endings. State it; do not let the OS default decide.
- **Null representation.** Decide and document the null token (empty field vs a sentinel). pyarrow writes
  an empty field for null by default; that is the right choice (ambiguity with empty-string is acceptable
  and documented, vs an `NA` sentinel that collides with real data).

> **Anti-pattern:** offering CSV as the *default* "because it's simpler". It is simpler to write and
> worse in every dimension that matters for a 10M-row market-data feed (size, type-safety, prune-ability).
> Parquet defaults; CSV is the explicitly-requested conversion.

---

## 2. Partitioning a date-partitioned series feed (Hive / directory layout)

### 2.1 The layout

A date-partitioned feed is written as a **Hive-partitioned dataset**: a directory tree where each level
is `key=value` and the leaf directories hold the data files
([Arrow `HivePartitioning`](https://arrow.apache.org/docs/python/generated/pyarrow.dataset.HivePartitioning.html)).
For our market-data exports the partition keys are **dataset id** and **date**:

```
export-root/
└── manifest-<destinationId>-<runId>.json          ← the one manifest for the run
└── data/
    ├── dataset=us_treasury_yields/
    │   ├── dt=2026-06-22/
    │   │   └── part-0000.zstd.parquet
    │   ├── dt=2026-06-23/
    │   │   └── part-0000.zstd.parquet
    │   └── dt=2026-06-24/
    │       └── part-0000.zstd.parquet
    └── dataset=sp500_ohlcv/
        ├── dt=2026-06-23/
        │   ├── part-0000.zstd.parquet
        │   └── part-0001.zstd.parquet            ← a large day spills into multiple parts
        └── dt=2026-06-24/
            └── part-0000.zstd.parquet
```

This is the pyarrow `write_to_dataset` directory scheme verbatim: *"for each combination of partition
columns and values, subdirectories are created … `root_dir/group1=value1/group2=value1/<uuid>.parquet`"*,
and Hive partitioning is *"a multi-level, directory-based partitioning scheme with all data files stored
in the leaf directories"*
([Arrow Tabular Datasets](https://arrow.apache.org/docs/python/dataset.html);
[Arrow `write_to_dataset`](https://arrow.apache.org/docs/python/generated/pyarrow.parquet.write_to_dataset.html)).

### 2.2 Why this layout and not the alternatives

- **Why partition on `dt` at all?** A consumer almost always wants a *date range*, and our own
  re-ingestion + retry logic wants to re-deliver *a single missing day* without rewriting the whole feed.
  Hive partitioning lets both **prune to the dates they touch** — the reader skips `dt=` directories
  outside the requested range without opening a single file. (This is the file-layer analogue of
  TimescaleDB chunk exclusion in the warehouse skill,
  [`timescaledb-timeseries`](../../../skills/timescaledb-timeseries/SKILL.md).)
- **Why `dataset=` as the top level?** A multi-dataset export keeps each dataset's files (and its
  `commercialOk` verdict) in its own subtree, so a per-dataset license filter is a directory filter.
- **Why not partition on `instrument_id`?** Cardinality. The S&P 500 is 500 directories per day; a full
  equity universe is tens of thousands — partitioning on a high-cardinality column produces a directory
  explosion and millions of tiny files, which destroys read performance (this is the "too many small
  files" anti-pattern, the partitioning analogue of a high-cardinality `segmentby` killing compression in
  the warehouse). **Partition on low-cardinality, range-queried keys (`dt`, `dataset`); keep
  `instrument_id` as a *column* inside the file**, sorted so its row-group min/max stats prune it.
- **Date granularity.** `dt=YYYY-MM-DD` for daily/intraday feeds. For tick or 1-minute feeds at high
  volume, add `hr=HH` under `dt=` so a single partition stays a sane file size (target **128 MB–1 GB per
  Parquet file**; below ~100 MB the per-file footer overhead and open-cost dominate, above ~1 GB you lose
  parallelism). Size the partition to the data rate, not by reflex — the same discipline as sizing a
  hypertable chunk.

### 2.3 File naming inside a partition

Files within a leaf directory are named `part-<NNNN>.<codec>.<ext>` — zero-padded sequence, codec, and
extension (`part-0000.zstd.parquet`, `part-0000.gzip.csv`). Two non-negotiables from the file-delivery
literature:

- **Names must be unique and stable.** *"Files posted with the same name will be overwritten"* and *"file
  naming patterns should be kept consistent over time to enable automated auditing"*
  ([Openbridge best practices](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices)).
  The `runId` in the manifest name + the `part-NNNN` sequence guarantees uniqueness across re-runs without
  clobbering a prior run's output.
- **No spaces, no special characters, no leading dot.** Openbridge blocks hidden/dot-prefixed files and
  files with spaces/special characters outright. Stick to `[a-z0-9_=.-]`. The `key=value` partition
  segments and the `part-NNNN.codec.ext` leaf are all within that set.

---

## 3. The manifest — the contract that describes the bundle

### 3.1 Why a manifest exists at all

A bundle of files in a bucket is just bytes; the **manifest is the index, the integrity record, the
licensing record, and the recovery record**. Its four jobs, each grounded:

1. **Index** — list every file, where it is, and how many rows/bytes it holds. (Adobe: the manifest
   *"contains information about the export location, export size, and more"*; fields `flowRunId`,
   `scheduledTime`, `exportResults[].sinkPath`, `.name`, `.size`
   ([AEP Data Landing Zone](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/cloud-storage/data-landing-zone)).)
2. **Integrity** — carry a per-file checksum so the consumer can verify the transfer was not corrupted or
   truncated.
3. **Licensing** — carry per-file `commercialOk` + `attribution` so a bulk export can't launder a RED
   series, and so the consumer knows the required credit string to render.
4. **Recovery** — be the source-system record of *what should exist*, so a partial/failed run can be
   redelivered. Openbridge: *"A manifest of files should be maintained … identifying the files to be
   delivered and their state (success, failure, pending) … so the source system would know to attempt a
   redeliver for any file"*
   ([Openbridge](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices)).

### 3.2 The naming convention: `manifest-<destinationId>-<runId>.json`

We adopt the AEP convention verbatim: the manifest filename is
`manifest-<<destinationId>>-<<dataflowRunId>>.json`
([AEP Data Landing Zone](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/cloud-storage/data-landing-zone)).
Mapped to our nouns:

- `destinationId` = the configured **delivery destination** (the client's bucket/SFTP target — one client
  may have several).
- `runId` = the **ingest/export run** UUID, the *same* `run_id` that the provenance stamp and the
  OpenLineage `RunEvent` already carry
  ([`data-normalization-tet/patterns-provenance-stamping.md`](../../../skills/data-normalization-tet/references/patterns-provenance-stamping.md)
  §2.1 `run_id`). Using the one run id across provenance → store → manifest means a single id traces a
  number from the upstream fetch all the way to the file in the client's bucket.

So a manifest filename is e.g.
`manifest-acme-prod-bucket-9f3c1e22-7b41-4d8e-a0c2-1e5b9d7f0a44.json`. The `runId` makes it unique per
run (a re-run gets a new run id and a new manifest); the `destinationId` makes it unambiguous which
client/target it describes when many manifests share a directory.

### 3.3 The manifest JSON schema

The AEP baseline is `{flowRunId, scheduledTime, exportResults:[{sinkPath, name, size}]}`
([verbatim sample](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/cloud-storage/data-landing-zone)):

```json
{
  "flowRunId": "0ac8f3c0-29bd-40aa-82c1-f1b7e0657b19",
  "scheduledTime": "2023-08-18T01:00:00Z",
  "exportResults": [
    { "sinkPath": "/destination/output001",
      "name": "amazon-s3_segment-name_20230818_010718.json",
      "size": 145854 }
  ]
}
```

That baseline has the index and the location but **none of the integrity, licensing, or schema fields** a
market-data distribution needs. Our manifest is that baseline *extended* — the run-level envelope plus a
richer per-file record:

```json
{
  "run_id": "9f3c1e22-7b41-4d8e-a0c2-1e5b9d7f0a44",
  "destination_id": "acme-prod-bucket",
  "generated_at": "2026-06-24T01:05:11Z",
  "schema_version": "2.1.0",
  "manifest_version": "1.0",
  "total_rows": 1284113,
  "total_bytes": 41982374,
  "file_count": 5,
  "files": [
    {
      "name": "data/dataset=us_treasury_yields/dt=2026-06-24/part-0000.zstd.parquet",
      "dataset": "us_treasury_yields",
      "format": "parquet",
      "compression": "zstd",
      "rows": 11,
      "bytes": 4821,
      "sha256": "b1946ac92492d2347c6235b4d2611184…b6b7e0c3e0",
      "series_ids": ["UST.CMT.1M", "UST.CMT.3M", "UST.CMT.10Y", "UST.CMT.30Y"],
      "as_of": "2026-06-24",
      "commercialOk": true,
      "ledger_verdict": "GREEN",
      "attribution": null
    },
    {
      "name": "data/dataset=sp500_ohlcv/dt=2026-06-24/part-0000.zstd.parquet",
      "dataset": "sp500_ohlcv",
      "format": "parquet",
      "compression": "zstd",
      "rows": 500,
      "bytes": 28114,
      "sha256": "3f786850e387550fdab836ed7e6dc881…de2929b9d2",
      "series_ids": ["AAPL", "MSFT", "…"],
      "as_of": "2026-06-24",
      "commercialOk": false,
      "ledger_verdict": "RED",
      "attribution": null
    }
  ]
}
```

#### 3.3.1 Every field and why it is load-bearing

**Run-level envelope:**

| Field | Type | Why it exists |
|---|---|---|
| `run_id` | UUID | The single id threading provenance → store → manifest → OpenLineage. The recovery key: redeliver everything for this run. |
| `destination_id` | str | Which delivery target this bundle is for (mirrors AEP `destinationId` in the filename). |
| `generated_at` | RFC-3339 UTC | When the bundle was produced (AEP `scheduledTime`). Drives the consumer's "is this stale" check. |
| `schema_version` | semver | The **dataset schema** version (column set/types). A consumer pins to a major; a major bump signals a breaking change (§6). |
| `manifest_version` | semver | The **manifest format** version, distinct from the data schema. Lets us add manifest fields without ambiguity about which evolved. |
| `total_rows` | int | Sum of every file's `rows`. A one-line completeness check: does it match what was requested? |
| `total_bytes` | int | Sum of `bytes`. Sanity/cost check before download. |
| `file_count` | int | `len(files)`. Catches a truncated manifest. |
| `files` | array | The per-file records below. |

**Per-file record (`files[]`):**

| Field | Type | Why it exists |
|---|---|---|
| `name` | str (relative path) | Path within the bundle root (AEP `sinkPath`+`name`, merged to a relative path). Encodes the Hive partition. |
| `dataset` | str | Which dataset this file belongs to (redundant with the path, but explicit so a consumer needn't parse the path). |
| `format` | `"parquet" \| "csv"` | The file type, so the consumer picks the right reader. |
| `compression` | `"zstd" \| "snappy" \| "gzip" \| "none"` | The codec, so the consumer's reader configures correctly (Parquet self-describes, but CSV+gzip does not). |
| `rows` | int | Row count in this file. Per-file completeness; sums to `total_rows`. |
| `bytes` | int | File size (AEP `size`). Integrity + cost. |
| `sha256` | hex(64) | **The checksum** (§4). Integrity + idempotent dedup. |
| `series_ids` | list[str] | Which series are inside this file. Lets a consumer fetch only files containing the series they want, and is the licensing dimension when verdicts are per-series. |
| `as_of` | date/datetime | The economic timestamp the data refers to (the `dt` partition), distinct from `generated_at`. Mirrors the provenance `as_of`. |
| `commercialOk` | bool (**default false**) | **The per-file display-license verdict.** §5. The whole-bundle licensing gate is enforced per file. |
| `ledger_verdict` | `GREEN\|YELLOW\|RED\|REJECT\|MISS` | The raw verdict kept distinct from the boolean, so `MISS`/`YELLOW` are visible (both → `commercialOk:false`, for different reasons). Mirrors the provenance model. |
| `attribution` | str \| null | The required credit string (CC-BY / GDELT) the consumer is contractually obliged to render, or null for bare public-domain. |

The `commercialOk`/`ledger_verdict`/`attribution` trio is **copied straight from the series'
`Provenance` record** built at the fetch boundary
([`data-normalization-tet/patterns-provenance-stamping.md`](../../../skills/data-normalization-tet/references/patterns-provenance-stamping.md)
§2). The manifest does not *re-derive* a verdict; it carries the stamp forward to the file. That is the
same "stamp once, carry forever" discipline applied one layer further out — from the row to the file.

### 3.4 The manifest as a Pydantic v2 model (runnable)

```python
# app/distribution/manifest.py
from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class FileEntry(BaseModel):
    """One file in the bundle. The licensing trio is copied from the series Provenance."""
    model_config = ConfigDict(frozen=True)

    name: str                              # relative path within the bundle root
    dataset: str
    format: Literal["parquet", "csv"]
    compression: Literal["zstd", "snappy", "gzip", "none"]
    rows: int = Field(ge=0)
    bytes: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")     # lower-hex, 64 chars
    series_ids: list[str]
    as_of: date | datetime
    commercial_ok: bool = Field(default=False, alias="commercialOk")  # DEFAULT FALSE
    ledger_verdict: Literal["GREEN", "YELLOW", "RED", "REJECT", "MISS"]
    attribution: str | None = None

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    @model_validator(mode="after")
    def _green_only_and_attributed(self) -> "FileEntry":
        # 1) commercial_ok=True is only legal for a GREEN file (mirror of the gate).
        if self.commercial_ok and self.ledger_verdict != "GREEN":
            raise ValueError(
                f"file {self.name}: commercialOk=True illegal with verdict={self.ledger_verdict}; "
                "the verdict comes from the series provenance / sources-ledger.")
        # 2) a REJECT file must never be in a bundle at all (it should never have been ingested).
        if self.ledger_verdict == "REJECT":
            raise ValueError(f"file {self.name}: a ⛔ REJECT series must not be exported.")
        return self


class Manifest(BaseModel):
    model_config = ConfigDict(frozen=True)

    run_id: UUID
    destination_id: str
    generated_at: datetime
    schema_version: str            # the DATA schema version (semver)
    manifest_version: str = "1.0"  # the MANIFEST format version (semver)
    files: list[FileEntry]

    # derived, but serialized so the consumer needn't recompute
    total_rows: int = 0
    total_bytes: int = 0
    file_count: int = 0

    @model_validator(mode="after")
    def _fill_and_check_totals(self) -> "Manifest":
        tr = sum(f.rows for f in self.files)
        tb = sum(f.bytes for f in self.files)
        # Manifest is frozen; recompute via __dict__ before freeze in the builder, OR
        # assert the caller passed correct totals. Here we assert (builder fills them).
        if self.total_rows not in (0, tr):
            raise ValueError(f"total_rows {self.total_rows} != sum(files.rows) {tr}")
        if self.total_bytes not in (0, tb):
            raise ValueError(f"total_bytes {self.total_bytes} != sum(files.bytes) {tb}")
        if self.file_count not in (0, len(self.files)):
            raise ValueError(f"file_count {self.file_count} != len(files) {len(self.files)}")
        return self

    def manifest_filename(self) -> str:
        # the AEP convention: manifest-<destinationId>-<runId>.json
        return f"manifest-{self.destination_id}-{self.run_id}.json"
```

The validator does in the manifest exactly what the `Provenance._green_only` validator does at the fetch
boundary — it is the **same gate, re-applied at the file layer**, so an illegal `commercialOk:true` can't
be introduced when the manifest is assembled. The `manifest_filename()` method enforces the AEP naming
convention in one place.

---

## 4. Checksums — integrity and idempotent dedup

### 4.1 The algorithm: SHA-256

Every file carries a **SHA-256** hex digest. Why SHA-256 and not the legacy MD5 that some transfer
protocols default to:

- A checksum is *"a unique digital fingerprint calculated from data … SHA-256 always outputs 64
  hexadecimal characters. Change a single bit in the input, and the output changes completely"*
  ([Kestrel hash guide](https://blog.kestreltools.com/blog/file-integrity-verification-hash-checksum-guide-2026/)).
- SHA-256 *"significantly enhances security by providing a 256-bit hash that reduces hash collision risks
  compared to SHA-1 and MD5"*
  ([deduplication research](https://link.springer.com/article/10.1007/s44163-025-00447-x)).
- The transfer layer may *additionally* validate with whatever the protocol supports — Openbridge's SFTP
  validates with a 128-bit MD5 by default but also supports `XSHA256` (SHA-256), `XSHA512`, `XCRC`
  ([Openbridge](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices)).
  The manifest's `sha256` is the **content** fingerprint independent of the wire protocol; the transport
  checksum protects the *transfer*, the manifest checksum protects the *content end to end*.

### 4.2 The two jobs a checksum does

1. **Integrity / corruption detection.** The consumer hashes the file it received and compares to the
   manifest `sha256`. A mismatch means corruption-in-transit, a CDN serving a stale cache, a truncated
   file (Parquet's classic failure: *"the file being truncated or still being written (missing footer)"*
   [viewparquet](https://viewparquet.com/parquet-faq)), or tampering. This is the published-checksum
   contract: *"if you hash this file and get the same value, you have exactly what I uploaded"*
   ([Kestrel](https://blog.kestreltools.com/blog/file-integrity-verification-hash-checksum-guide-2026/)).

2. **Idempotent dedup.** *"Hash is a calculated result based on the content of the file. Same file, same
   hash every time. This property ensures idempotent behavior — processing the same file repeatedly
   yields identical results"*
   ([deduplication search synthesis]; the same principle is Salesforce Data 360's
   *"Data 360 computes checksums to identify and skip previously processed files … reprocessing the same
   file does not result in duplicate records"*
   [Salesforce Data 360](https://architect.salesforce.com/docs/architect/fundamentals/guide/data360_integration_patterns_and_practices)).
   So a re-run that produces a byte-identical file (same data, same day) produces the **same sha256**, and
   the consumer's ingest **skips it** — no duplicate rows, no wasted load. The checksum *is* the
   idempotency key for the file.

> **Determinism caveat that bites in production.** "Same data → same hash" only holds if the writer is
> **deterministic**: same input rows in the same order, same codec + codec level, no embedded random uuid
> in the filename, no wall-clock timestamp written *inside* the Parquet metadata. pyarrow's
> `write_to_dataset` default names files with a **random uuid** (`<uuid>.parquet`) — that randomness must
> be replaced with a deterministic `part-NNNN` name (§7) or two identical runs produce different paths
> (the *content* hash is still equal, but you lose path-level idempotency). Sort rows by
> `(instrument_id, ts)` before writing so row order is stable; pin the codec + level; keep volatile
> metadata out of the file. Then "same data → same file → same hash" actually holds.

### 4.3 Computing the digest (runnable, streaming)

```python
# app/distribution/checksum.py
import hashlib
from pathlib import Path

_CHUNK = 1 << 20  # 1 MiB — never read a multi-GB file into memory to hash it


def sha256_file(path: str | Path) -> tuple[str, int]:
    """Stream the file through SHA-256; return (hex_digest, byte_count).
    Streaming (not read-all) so a 2 GB Parquet file hashes in O(1) memory."""
    h = hashlib.sha256()
    total = 0
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(_CHUNK), b""):
            h.update(block)
            total += len(block)
    return h.hexdigest(), total
```

The digest is computed **after** the file is fully written and closed (a Parquet footer is written last;
hashing a half-written file hashes a corrupt file). The returned `bytes` is taken from the same pass, so
`bytes` and `sha256` describe the identical on-disk artifact — never compute `bytes` from `os.stat` in a
separate call that could race a still-flushing write.

---

## 5. Per-file `commercialOk` — a bulk export cannot launder a RED series

This is the highest-blast-radius section. It maps directly to the red-team **F2** goal — *"a composite
that inherits a RED input yet claims GREEN"* — and its bulk-export variant: a tar of files where one RED
file rides inside a `commercialOk:true` distribution
([`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md) F2;
[`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md)).

### 5.1 The rule

1. **Each file carries its own `commercialOk` + `ledger_verdict` + `attribution`,** copied from the
   `Provenance` of the series it contains. The manifest never re-derives a verdict — it propagates the
   stamp ([`data-normalization-tet/patterns-provenance-stamping.md`](../../../skills/data-normalization-tet/references/patterns-provenance-stamping.md)
   §"stamp once, carry forever").
2. **A file may contain only series that share a verdict.** Do **not** pack a GREEN series and a RED
   series into the same Parquet file — that file would have no single honest `commercialOk`. The export
   assembler **groups series by verdict into separate files** (and separate `dataset=` subtrees) so every
   file's verdict is unambiguous. This is the file-level form of the contamination rule: you cannot mix
   licenses inside one artifact.
3. **A bundle's effective license is the most-restrictive file in it.** If a consumer's destination is
   licensed for commercial display, the assembler **excludes** (or refuses) any non-GREEN file from a
   `commercialOk:true` delivery. A RED file may still be delivered to an *internal/personal-use*
   destination with `commercialOk:false` and attribution shown — RED gates the *display license*, not
   *access* ([`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) §"In practice").
4. **A REJECT series is never in a bundle at all** — it should never have been ingested (the
   `FileEntry` validator rejects `ledger_verdict=="REJECT"`, belt-and-braces).
5. **CC-BY GREEN files carry the required `attribution` string,** and the manifest is the record of that
   obligation: an un-attributed CC-BY display breaks the license even though the verdict is GREEN, so the
   consumer must render the credit. A `commercialOk:true` file with a null `attribution` for a CC-BY
   source is a `/sources-lint` FIX.

### 5.2 The assembler gate (runnable)

```python
# app/distribution/license_gate.py
from app.distribution.manifest import FileEntry


class BulkLicenseError(RuntimeError):
    """Raised when a non-GREEN file would enter a commercial-display bundle."""


def assert_bundle_license(
    files: list[FileEntry], *, destination_allows_commercial_display: bool
) -> None:
    """
    The bulk-export gate. A commercial-display destination may receive ONLY GREEN files.
    This is where a bulk export is prevented from laundering a RED series.
    """
    # 1) no file may claim commercialOk without a GREEN verdict (the per-file gate; also
    #    enforced by the FileEntry validator — re-checked here at assembly time)
    for f in files:
        if f.commercial_ok and f.ledger_verdict != "GREEN":
            raise BulkLicenseError(
                f"{f.name}: commercialOk=True with verdict={f.ledger_verdict}")
        if f.ledger_verdict == "REJECT":
            raise BulkLicenseError(f"{f.name}: ⛔ REJECT must not be exported")

    # 2) if this destination displays commercially, EXCLUDE/refuse any non-GREEN file
    if destination_allows_commercial_display:
        offenders = [f.name for f in files if f.ledger_verdict != "GREEN"]
        if offenders:
            raise BulkLicenseError(
                "commercial-display destination cannot receive non-GREEN files: "
                + ", ".join(offenders)
                + " — drop them, or deliver to an internal/personal-use destination "
                  "with commercialOk:false and attribution rendered.")

    # 3) every GREEN CC-BY file must carry its required attribution string
    for f in files:
        if f.commercial_ok and f.attribution is None and _is_ccby(f):
            raise BulkLicenseError(
                f"{f.name}: CC-BY GREEN file is missing its required attribution string")


def _is_ccby(f: FileEntry) -> bool:
    # CC-BY GREENs (World Bank / OECD / IMF / GDELT) require a rendered credit line.
    # In practice this is read from the series provenance license_basis; sketched here.
    return f.attribution is not None or f.dataset in {
        "worldbank_wdi", "oecd_sdmx", "imf_ifs", "gdelt_tone"}
```

### 5.3 Why the file is the right granularity (not the row, not the bundle)

- **Not the row.** Stamping `commercialOk` on every row duplicates a verdict across a billion rows and
  invites drift between copies — the same reason the warehouse stores provenance once per series, not per
  tick ([`data-normalization-tet/patterns-provenance-stamping.md`](../../../skills/data-normalization-tet/references/patterns-provenance-stamping.md)
  §6.4). A Parquet file already groups rows of one verdict, so the file is the natural carrier.
- **Not the bundle.** A single bundle-level verdict would force the *whole* export to the most-restrictive
  member, even when a consumer wanted only the GREEN datasets. Per-file lets the assembler **filter** to
  the GREEN subset for a commercial destination and deliver the full set (RED included, gated) to an
  internal one.
- **The file is the contamination boundary.** A Parquet file is the smallest unit a consumer reads and
  re-shares as a whole; if its contents share one verdict, the file *is* a clean licensing atom.

---

## 6. Schema stability across runs — additive-only

A consumer pins ETL to the bundle's columns. The contract: **the schema may grow but never shift.**

### 6.1 What is safe vs breaking

| Change | Safe? | Why | Mechanism |
|---|---|---|---|
| **Add a new nullable column** | ✅ safe | old files lack it; readers fill NULL — *"adding a new column is generally safe. Historical files simply lack this column … the query engine fills the missing values with NULL"* ([apxml](https://apxml.com/courses/intro-data-lake-architectures/chapter-3-ingestion-pipelines/handling-schema-evolution)) | minor `schema_version` bump |
| **Rename a column** | ❌ **breaking** | Parquet/CSV resolve by **name**; *"if you rename a column from `user_id` to `customer_id`, the system interprets this as dropping `user_id` and adding a new column `customer_id` with all null values for historical data"* ([Polars schema-evolution](https://pola.rs/posts/schema-evolution/)) | **major** bump + deprecation cycle |
| **Reorder columns** | ⚠️ breaking for CSV / positional readers | CSV has no schema but the header order; a positional reader breaks. Parquet readers that resolve by name tolerate it, but don't rely on it | avoid; treat as breaking |
| **Change a column's type** | ❌ breaking | a reader expecting `int64` chokes on `string`; silent coercion corrupts values | **major** bump |
| **Drop a column** | ❌ breaking | a consumer referencing it breaks | major bump + deprecation |

The deep reason a rename is breaking: **Parquet uses column names as identifiers** (name-based
resolution). True ID-based resolution — where a rename keeps the column's integer id and only changes its
display name — exists only in table formats like **Apache Iceberg** (*"If `user_id` (ID: 1) is renamed to
`customer_id`, the ID remains 1; the metadata simply updates the display name"*
[apxml](https://apxml.com/courses/intro-data-lake-architectures/chapter-3-ingestion-pipelines/handling-schema-evolution)).
We deliver **raw Parquet/CSV files**, not an Iceberg table, so we have name-based resolution and a rename
**is** a drop+add. Don't pretend otherwise.

### 6.2 The discipline

1. **Additive only between minor versions.** New columns are appended and **nullable**, so a consumer on
   the old schema ignores them and a consumer on the new one fills NULL for historical files.
2. **A rename/reorder/retype/drop is a `schema_version` MAJOR bump.** Ship the new column **alongside**
   the old for a deprecation window (`yield_10y` and the deprecated `BC_10YEAR` both present), announce
   the removal date, then drop the old in the next major. Never an in-place rename.
3. **`schema_version` is in the manifest**, so a consumer can hard-fail on an unexpected major instead of
   silently mis-reading. It is **distinct from `manifest_version`** — the data schema and the manifest
   format evolve independently.
4. **Openbridge's narrow exception, stated honestly:** *"if only the name of the column … changes but the
   underlying data type and order of fields stay the same, the file should be processed successfully —
   the field name in the resulting warehouse table will continue to reflect the original field name"*
   ([Openbridge](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices)).
   That is a *positional*-ingest tolerance specific to their pipeline; **do not** rely on it as a general
   rule — most consumers resolve by name and a rename breaks them. We treat rename as breaking, full stop.

---

## 7. The worked pyarrow writer + manifest emitter (runs on the worker)

This is the whole recipe in runnable form, on the **worker** (off the request path — bulk export is heavy
I/O and CPU; it never runs in a FastAPI request handler, mirroring non-negotiable #4 and the
`python-fastapi-data-service` worker boundary). pyarrow **24.0.0** (released 2026-04-21,
[PyPI](https://pypi.org/project/pyarrow/)).

### 7.1 Writing one partition's Parquet file deterministically

```python
# app/distribution/parquet_writer.py
from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from app.distribution.checksum import sha256_file


def write_partition_parquet(
    table: pa.Table,
    *,
    out_path: Path,
    compression: str = "zstd",      # default codec for Parquet (§8)
    compression_level: int | None = 3,
    row_group_size: int = 256 * 1024,   # rows per row group; tune to ~128MB groups
) -> tuple[str, int, int]:
    """
    Write ONE deterministic Parquet file and return (sha256, bytes, rows).
    Deterministic = sorted rows + pinned codec/level + no random filename/metadata,
    so an identical re-run yields an identical file and thus an identical sha256.
    """
    # 1) deterministic row order — same data must serialize the same way
    table = table.sort_by([("instrument_id", "ascending"), ("ts", "ascending")])

    out_path.parent.mkdir(parents=True, exist_ok=True)

    # 2) write with pinned, self-describing settings
    pq.write_table(
        table,
        out_path,
        compression=compression,            # 'zstd' | 'snappy' | 'gzip' | 'none'
        compression_level=compression_level,
        version="2.6",                      # modern Parquet logical types (timestamps, etc.)
        use_dictionary=True,                # dict-encode low-cardinality cols (symbol)
        write_statistics=True,              # min/max/null_count per row group -> pushdown
        store_schema=True,                  # embed the Arrow schema (exact type round-trip)
        # NOTE: do NOT write a wall-clock into custom file metadata — it would break
        # byte-determinism and thus the content-hash idempotency.
    )

    digest, nbytes = sha256_file(out_path)
    return digest, nbytes, table.num_rows
```

Every keyword here is a real pyarrow `write_table` parameter
([pyarrow Parquet docs](https://arrow.apache.org/docs/python/parquet.html)): `compression`
(`'snappy'`/`'gzip'`/`'zstd'`), `version` (`'2.6'`), `use_dictionary`, `write_statistics`,
`store_schema`, `compression_level`. `write_statistics=True` is what populates the row-group min/max/
null-count stats that let a consumer's reader prune; `store_schema=True` embeds the Arrow schema so a
`decimal128`/`timestamp[us, tz=UTC]` round-trips with full fidelity.

### 7.2 Writing the whole Hive-partitioned dataset (the `file_visitor` path)

When writing many partitions at once, `pq.write_to_dataset` + a `file_visitor` collects each written
file's path/metadata/size in one pass — pyarrow calls the visitor *"with a `WrittenFile` instance for
each file created"*, and `WrittenFile` has `path` (str), `metadata` (the Parquet `FileMetaData`, or
None for CSV), and `size` (int64 bytes)
([Arrow `write_to_dataset`](https://arrow.apache.org/docs/python/generated/pyarrow.parquet.write_to_dataset.html);
[`WrittenFile`](https://arrow.apache.org/docs/python/generated/pyarrow.dataset.WrittenFile.html)):

```python
# app/distribution/dataset_writer.py
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from app.distribution.checksum import sha256_file


def write_dataset_collecting(
    table: pa.Table, *, root: Path, partition_cols: list[str], compression: str = "zstd"
) -> list[dict]:
    """
    Write a Hive-partitioned dataset and collect per-file (path, rows, bytes, sha256).
    `partition_cols` -> directory layout root/dataset=.../dt=.../part-*.parquet
    """
    written: list[dict] = []

    def _visit(wf) -> None:  # wf: pyarrow.dataset.WrittenFile
        p = Path(wf.path)
        rows = wf.metadata.num_rows if wf.metadata is not None else None  # parquet only
        digest, nbytes = sha256_file(p)
        written.append({"path": str(p.relative_to(root)), "rows": rows,
                        "bytes": nbytes, "sha256": digest})

    pq.write_to_dataset(
        table,
        root_path=str(root),
        partition_cols=partition_cols,      # e.g. ["dataset", "dt"] -> dataset=.../dt=...
        compression=compression,
        file_visitor=_visit,                # called once per written file
        # deterministic naming: replace the default random-uuid basename
        basename_template="part-{i}.zstd.parquet",
        existing_data_behavior="overwrite_or_ignore",
    )
    return written
```

Two production details: `basename_template="part-{i}.zstd.parquet"` overrides pyarrow's **default random
uuid filename** so re-runs are path-stable (§4.2 determinism caveat), and `file_visitor` gives us
`rows`/`bytes`/`sha256` without a second directory walk. `wf.metadata.num_rows` reads the row count
straight from the footer the writer just produced
([`WrittenFile.metadata`](https://arrow.apache.org/docs/python/generated/pyarrow.dataset.WrittenFile.html)).

### 7.3 The CSV path (on request)

```python
# app/distribution/csv_writer.py
import gzip
from pathlib import Path

import pyarrow as pa
import pyarrow.csv as pacsv

from app.distribution.checksum import sha256_file


def write_partition_csv(table: pa.Table, *, out_path: Path) -> tuple[str, int, int]:
    """Write one gzip-compressed CSV file; return (sha256, bytes, rows)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    opts = pacsv.WriteOptions(
        include_header=True,                # the header IS the CSV schema — always write it
        quoting_style="needed",             # quote only when a value contains , " or \n
    )
    # write CSV to a buffer, then gzip it (CSV doesn't self-describe its codec)
    sink = pa.BufferOutputStream()
    pacsv.write_csv(table, sink, write_options=opts)
    raw = sink.getvalue().to_pybytes()
    with gzip.open(out_path, "wb", compresslevel=6) as gz:
        gz.write(raw)
    digest, nbytes = sha256_file(out_path)
    return digest, nbytes, table.num_rows
```

`pacsv.WriteOptions(include_header=..., quoting_style=...)` are the real pyarrow CSV options:
`include_header` (default True), and `quoting_style` ∈ `{"needed", "all_valid", "none"}` where `"needed"`
*"only enclose values in quotes when needed"* and `"none"` *"will raise an error"* on a special character
([pyarrow `WriteOptions`](https://arrow.apache.org/docs/python/generated/pyarrow.csv.WriteOptions.html)).
We choose `"needed"` (minimal, valid quoting) and gzip the result.

### 7.4 Assembling the manifest and gating it

```python
# app/distribution/build_bundle.py
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import UUID

import pyarrow as pa

from app.distribution.dataset_writer import write_dataset_collecting
from app.distribution.license_gate import assert_bundle_license
from app.distribution.manifest import FileEntry, Manifest
# series-level provenance, built by the TET write path:
from app.provenance.models import Provenance


def build_bundle(
    *,
    table: pa.Table,                       # already normalized + provenance-resolved
    series_provenance: dict[str, Provenance],   # series_id -> its stamp
    root: Path,
    run_id: UUID,
    destination_id: str,
    schema_version: str,
    destination_allows_commercial_display: bool,
    compression: str = "zstd",
) -> Manifest:
    # 1) write the Hive-partitioned Parquet files, collecting per-file facts
    written = write_dataset_collecting(
        table, root=root, partition_cols=["dataset", "dt"], compression=compression)

    # 2) turn each written file into a FileEntry, COPYING the verdict from provenance
    entries: list[FileEntry] = []
    for w in written:
        dataset, dt = _parse_partition(w["path"])          # from dataset=.../dt=...
        series_ids = _series_in_file(table, dataset, dt)   # which series this file holds
        prov = _shared_provenance(series_ids, series_provenance)  # they share one verdict
        entries.append(FileEntry(
            name=w["path"],
            dataset=dataset,
            format="parquet",
            compression=compression,
            rows=w["rows"],
            bytes=w["bytes"],
            sha256=w["sha256"],
            series_ids=series_ids,
            as_of=date.fromisoformat(dt),
            commercialOk=prov.commercial_ok,               # COPIED, never re-derived
            ledger_verdict=prov.ledger_verdict.value,
            attribution=prov.attribution,
        ))

    # 3) THE BULK-EXPORT GATE — a RED file cannot ride into a commercial bundle
    assert_bundle_license(
        entries, destination_allows_commercial_display=destination_allows_commercial_display)

    # 4) build the manifest (validators recompute totals + re-check the gate)
    manifest = Manifest(
        run_id=run_id,
        destination_id=destination_id,
        generated_at=datetime.now(timezone.utc),
        schema_version=schema_version,
        files=entries,
        total_rows=sum(e.rows for e in entries),
        total_bytes=sum(e.bytes for e in entries),
        file_count=len(entries),
    )

    # 5) write the manifest LAST, named per the AEP convention, next to the data
    (root / manifest.manifest_filename()).write_text(
        manifest.model_dump_json(by_alias=True, indent=2), encoding="utf-8")
    return manifest
```

The ordering is the whole point: data files first → checksums computed from the finished files → verdicts
copied from provenance → **gate** → manifest written **last**. The manifest's existence is the signal the
bundle is complete and licensed; a consumer that sees the data files but no manifest knows the run is
**still in progress or failed**, and must not ingest (the Openbridge "success/failure/pending" state
model, [Openbridge](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices)).
This mirrors Lumina's own non-negotiable #5 ("persist BEFORE the close signal"): the manifest is the
commit marker, written only after everything it describes exists on disk.

---

## 8. Compression — the decision and the numbers

### 8.1 The decision table

| Format | Default codec | When to override | Why |
|---|---|---|---|
| **Parquet** | **zstd** (level 3) | `snappy` if the consumer is decompress-latency-bound and storage is free | zstd = Gzip-class ratio at Snappy-class decompress speed; it *"strictly dominates [Gzip] in both speed and ratio"* and is the data-lake default (Iceberg defaults Parquet to zstd) ([e6data](https://www.e6data.com/blog/fast-writes-apache-iceberg-snappy-vs-zstd)) |
| **CSV** | **gzip** (level 6) | `none` only for tiny human-opened files | CSV has no built-in codec; gzip is universally readable; AEP's CSV destinations offer `NONE`/`GZIP` ([AEP](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/api/activate-segments-file-based-destinations)) |

### 8.2 The three codecs, characterized (cited)

- **Snappy** — *"blazing-fast compression/decompression at the cost of larger files … a reasonable
  reduction (typically 1.5×–2×) with minimal CPU overhead"*; it is *"the default compression codec for
  Apache Parquet"*
  ([compression search synthesis](https://www.e6data.com/blog/fast-writes-apache-iceberg-snappy-vs-zstd)).
- **Zstd** — *"achieves much smaller files with a heavier compute footprint … a compression ratio
  comparable to Gzip but with decompression speeds closer to Snappy"*; *"the standard recommendation for
  general-purpose data-lake storage, offering a Pareto improvement over Gzip"*; *"switching from Snappy to
  Zstd can save 30% on storage bills"* at petabyte scale
  ([e6data](https://www.e6data.com/blog/fast-writes-apache-iceberg-snappy-vs-zstd)).
- **Gzip** — Gzip-class ratio but slower decompress than zstd; kept for **CSV** (where universal
  readability matters) and dominated by zstd for Parquet.

### 8.3 Why zstd is our Parquet default (first-principles)

A market-data distribution is **written once on the worker, downloaded and read many times by
consumers**. The economics favour spending a little more CPU at write time (worker, off the request path,
cost is ours and amortized) to produce a **smaller file** that is **cheaper to store** (our bucket
egress + the consumer's storage) and **fast to decompress** (consumer read time). zstd hits exactly that
trade: near-Gzip ratio (smaller files than Snappy) with near-Snappy decompress. We pin **level 3** — the
zstd default knee where ratio gains flatten and CPU climbs; raise to 6–9 only for cold-archive partitions
that are rarely read. Snappy stays available as a per-destination override for a latency-critical
consumer who values decompress speed over our storage bill.

> Note: Parquet applies the codec **per column chunk after encoding**, so the codec choice compounds with
> dictionary/RLE/delta encoding — the codec compresses the *already-encoded* bytes, which is why even
> Snappy on encoded Parquet beats raw gzip-on-CSV by a wide margin. The codec is the second win, not the
> first.

---

## 9. The full lifecycle of a delivered bundle (the picture)

```
                      WORKER (off the request path, cron / queue-driven)
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ 1. query the warehouse (TimescaleDB) for the date range + series             │
  │ 2. sort rows (instrument_id, ts)  ── determinism                              │
  │ 3. group series by commercialOk verdict ── no mixed-license file              │
  │ 4. write Hive-partitioned Parquet (zstd, write_statistics, store_schema)      │
  │      data/dataset=<id>/dt=<date>/part-NNNN.zstd.parquet                       │
  │ 5. file_visitor → (path, rows, bytes) ; sha256_file → digest                  │
  │ 6. copy verdict/attribution from series Provenance → FileEntry                │
  │ 7. assert_bundle_license  ── a RED file cannot enter a commercial bundle      │
  │ 8. Manifest(...) validators: totals + green-only gate                         │
  │ 9. write manifest-<destinationId>-<runId>.json  LAST (the commit marker)      │
  └──────────────────────────────────────────────────────────────────────────────┘
                                      │  push to client bucket / SFTP
                                      ▼
                      CONSUMER
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ a. read the manifest ; if absent → run incomplete, do NOT ingest             │
  │ b. for each file: re-hash, compare to sha256  ── integrity                    │
  │ c. if sha256 already ingested → skip  ── idempotent dedup                     │
  │ d. respect commercialOk + render attribution  ── licensing                    │
  │ e. read Parquet (typed, pruned)                                               │
  └──────────────────────────────────────────────────────────────────────────────┘
```

The single id (`run_id`) and the single content fingerprint (`sha256`) are what make the whole thing
**idempotent, recoverable, and auditable**: redeliver by `run_id`, dedup by `sha256`, trace any number
from the upstream fetch (provenance `run_id`) to the file in the client's bucket (manifest `run_id`).

---

## 10. R-SCALE — which tier this survives, and what breaks next

State the tier, in numbers ([`product-at-scale.md`](../../../rules/product-at-scale.md)):

| Surface | This recipe | Breaks at | The fix at the next tier |
|---|---|---|---|
| **Bundle size** | Hive partition + zstd; ~128 MB–1 GB per file | a single un-partitioned multi-GB file freezes a reader and can't be pruned | already mitigated: partition by `dt` (+`hr` for tick); cap file size, spill to `part-0001…` |
| **File count** | hundreds–low-thousands of files per run | tens of thousands of tiny files (e.g. partitioning on `instrument_id`) explodes directory + open cost | keep partition keys low-cardinality; pack a day's series into few files; `instrument_id` stays a sorted *column* |
| **Checksum cost** | streaming SHA-256, 1 MiB chunks, O(1) memory | hashing a 10 GB file serially adds minutes | hash partitions in parallel across worker cores; the per-file boundary already parallelizes |
| **Manifest size** | one JSON listing every file | a manifest listing 1M files is itself unwieldy | shard the manifest per dataset, or emit a top-level index manifest pointing at per-dataset manifests (the AEP-style `exportResults` array already supports this) |
| **Determinism / idempotency** | sorted rows + pinned codec + `part-NNNN` names | a non-deterministic writer (random uuid names, embedded timestamps) defeats dedup | the `basename_template` + sort + pinned level above; keep volatile metadata out of the file |

The honest ceiling: this is a **Tier-2→Tier-3** recipe (it scales by partitioning + parallel hashing +
manifest sharding). The thing that would force a different design is **not** file size but **table-format
semantics** — if consumers need transactional appends, time-travel, or true ID-based schema evolution
(rename without break), the move is to an **Iceberg/Delta table** instead of raw Parquet+manifest
([apxml schema evolution](https://apxml.com/courses/intro-data-lake-architectures/chapter-3-ingestion-pipelines/handling-schema-evolution)).
That is a measured, deliberate swap — not a reflex — and it is out of scope here; the raw-file
Distribution is the v1 Fusion-parity surface.

---

## 11. Decision checklist (use before locking any bundle-writer code)

1. **Is Parquet the default and CSV opt-in?** (CSV-as-default for a 10M-row feed is a FIX.)
2. **Is the feed Hive-partitioned on low-cardinality range keys (`dataset`, `dt`), with `instrument_id`
   as a sorted column — not a partition?**
3. **Are files named `part-NNNN.<codec>.<ext>` (deterministic, no random uuid, no spaces/dots), and is
   the manifest named `manifest-<destinationId>-<runId>.json`?**
4. **Does every file carry `rows`, `bytes`, `sha256`, `format`, `dataset`, `series_ids`, `as_of`,
   `commercialOk`, `ledger_verdict`, `attribution` — and does the run-level envelope carry `run_id`,
   `generated_at`, `schema_version`, `total_rows`?**
5. **Is `commercialOk` per file COPIED from the series `Provenance`, never re-derived — and does
   `assert_bundle_license` block a non-GREEN file from a commercial-display bundle?**
6. **Does a file contain only one license verdict (no GREEN+RED in one Parquet file)?**
7. **Is the SHA-256 streamed (O(1) memory), computed AFTER the file is closed, and used as the
   idempotency key?**
8. **Is the writer deterministic (sorted rows + pinned codec/level + no embedded wall-clock) so a re-run
   reproduces the same hash?**
9. **Is Parquet zstd / CSV gzip the codec, with `write_statistics=True` + `store_schema=True` on
   Parquet?**
10. **Is the manifest written LAST, as the commit marker, and is a schema change additive-only (a rename =
    major `schema_version` bump + deprecation, never in-place)?**
11. **Does the whole thing run on the WORKER, off the request path?**

If every box is checked, the bundle is typed, small, pruneable, integrity-checked, idempotent, and
license-honest — which is the entire job of the batch-file delivery channel.

---

## Sources

**Manifest format (the AEP convention we adopt + extend):**
- [Adobe Experience Platform — Data Landing Zone destination](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/cloud-storage/data-landing-zone) — manifest filename `manifest-<<destinationId>>-<<dataflowRunId>>.json`; fields `flowRunId`, `scheduledTime`, `exportResults[].sinkPath`, `.name`, `.size` (bytes); the verbatim sample manifest JSON.
- [Adobe AEP — Activate audiences to file-based destinations (Flow Service API)](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/api/activate-segments-file-based-destinations) — selectable file types CSV/JSON/PARQUET; CSV compression NONE/GZIP; the "include manifest file" toggle.

**Parquet vs CSV, partitioning, the pyarrow API (Arrow 24.0.0):**
- [Apache Arrow — Reading and Writing the Parquet Format (pyarrow)](https://arrow.apache.org/docs/python/parquet.html) — `pq.write_table(compression=, version=, use_dictionary=, write_statistics=, store_schema=, coerce_timestamps=)`; `pq.write_to_dataset(partition_cols=)`; reading schema/metadata.
- [Apache Arrow — Tabular Datasets](https://arrow.apache.org/docs/python/dataset.html) and [`HivePartitioning`](https://arrow.apache.org/docs/python/generated/pyarrow.dataset.HivePartitioning.html) — `/key=value/` directory layout, leaf-directory data files.
- [pyarrow `write_to_dataset`](https://arrow.apache.org/docs/python/generated/pyarrow.parquet.write_to_dataset.html) and [`WrittenFile`](https://arrow.apache.org/docs/python/generated/pyarrow.dataset.WrittenFile.html) — `file_visitor`, `WrittenFile.path/metadata/size`, `basename_template`, `_metadata` sidecar.
- [pyarrow CSV `WriteOptions`](https://arrow.apache.org/docs/python/generated/pyarrow.csv.WriteOptions.html) and [`write_csv`](https://arrow.apache.org/docs/python/generated/pyarrow.csv.write_csv.html) — `include_header`, `quoting_style` ∈ {needed, all_valid, none}.
- [pyarrow on PyPI](https://pypi.org/project/pyarrow/) — version pin 24.0.0 (released 2026-04-21).
- [Parquet metadata & statistics with pyarrow (MungingData)](https://www.mungingdata.com/pyarrow/parquet-metadata-min-max-statistics/) and [Dremio "All About Parquet" Pt.7](https://medium.com/data-engineering-with-dremio/all-about-parquet-part-07-metadata-in-parquet-improving-data-efficiency-9a613b099fb7) — row-group min/max/null_count footer statistics, predicate pushdown.

**Compression (snappy/zstd/gzip):**
- [e6data — Snappy vs ZSTD in Iceberg](https://www.e6data.com/blog/fast-writes-apache-iceberg-snappy-vs-zstd) — Snappy = Parquet default; Iceberg defaults Parquet to zstd; zstd Pareto-dominates Gzip; ~30% storage saving Snappy→zstd.

**Checksums, fingerprinting, idempotent dedup:**
- [Salesforce Data 360 — Integration patterns & practices](https://architect.salesforce.com/docs/architect/fundamentals/guide/data360_integration_patterns_and_practices) — file fingerprinting via checksums to skip previously-processed files; idempotent ingestion; idempotency keys; commit/checkpoint state. (403 to WebFetch; quoted via the indexed search result.)
- [Openbridge — Batch file delivery best practices](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices) — MD5/XSHA256/XSHA512/XCRC integrity validation; the success/failure/pending manifest + redeliver protocol; unique/consistent file naming; blocked extensions/spaces/dot-files; the narrow positional rename tolerance.
- [Kestrel — File integrity verification with hash checksums (2026)](https://blog.kestreltools.com/blog/file-integrity-verification-hash-checksum-guide-2026/) — SHA-256 = 64 hex chars; one-bit change → total digest change; the published-checksum contract.
- [Cross-platform dedup w/ data integrity (Springer, 2025)](https://link.springer.com/article/10.1007/s44163-025-00447-x) — SHA-256 reduces collision risk vs SHA-1/MD5; fingerprint-based dedup.
- [viewparquet — Parquet FAQ](https://viewparquet.com/parquet-faq) — reader reads last 8 bytes for footer length; truncated/missing-footer corruption mode.

**Schema stability / evolution:**
- [Polars — Handling schema issues](https://pola.rs/posts/schema-evolution/) — rename = drop+add under name-based resolution.
- [apxml — Handling schema evolution](https://apxml.com/courses/intro-data-lake-architectures/chapter-3-ingestion-pipelines/handling-schema-evolution) — add-column safe (NULL backfill); name-based vs ID-based resolution; Iceberg ID-based rename.

**Fusion Distribution format (the product we re-engineer):**
- [JPMorgan Fusion docs (PyFusion)](https://jpmorganchase.github.io/fusion/4.0.3/) and [Fusion data catalog](https://fusion.jpmorgan.com/content/public/home/data-catalog) — "Distribution = downloadable instances of a dataset, containing a file type such as CSV or Parquet"; CSV for business users, Parquet for large-data querying.

**In-repo (project) sources:**
- [`commercial-ok-gate.md`](../../../rules/commercial-ok-gate.md) — license attaches to the fetch path; default `false`; RED gates display not access; no fabricated/RED backfill.
- [`data-normalization-tet/patterns-provenance-stamping.md`](../../../skills/data-normalization-tet/references/patterns-provenance-stamping.md) — the `Provenance` record (`commercial_ok`/`ledger_verdict`/`attribution`/`run_id`), the contamination rule, "stamp once, carry forever", series-level (not per-row) storage.
- [`memory/sources-ledger.md`](../../../memory/sources-ledger.md) — the GREEN/YELLOW/RED/REJECT truth table the per-file verdict is copied from.
- [`red-team-negation-loop.md`](../../../rules/red-team-negation-loop.md) — F2 (a composite/bundle laundering a RED input is a CRITICAL).
- [`product-at-scale.md`](../../../rules/product-at-scale.md) — the R-SCALE tier discipline used in §10.
- [`distribution-mcp-channel/00-theory.md`](../../../../.agents/jpm-markets-reengineering/distribution-mcp-channel/00-theory.md) — the distribution-layer framing (one core, many taps; `Provenance`/`commercialOk` on every payload); the batch/file channel this doc builds.
- [`timescaledb-timeseries`](../../../skills/timescaledb-timeseries/SKILL.md) — the warehouse the export reads from (chunk-exclusion analogue of partition pruning).
- [`python-fastapi-data-service`](../../../skills/python-fastapi-data-service/SKILL.md) — the worker boundary: bulk export is heavy work, off the request path.
