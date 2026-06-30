# The BATCH channel: architecture of scheduled & on-demand extraction jobs

> **Skill:** `dataquery-delivery-channels` (JPM-Markets re-engineering **data-analytics product line** —
> **NOT Lumina**). New ground: a Python / FastAPI / data-engineering stack, separate from Lumina's
> Bun + Express + Prisma + Supabase + Upstash app.
> **Type:** `theory-*` — the generic, reusable conceptual model of the batch delivery channel. The
> *transport* recipes (presigned-S3 vs SFTP vs streamed download) and the *format* recipes
> (Parquet/CSV/manifest schema) live in the `patterns-*` siblings; this doc is the **conceptual half
> that comes before them** — what a batch job *is*, how it lives and dies, and the four invariants
> (manifest, atomicity, idempotency, partial-failure honesty) that make a feed trustworthy at scale.

---

## 0. The one-paragraph answer (read this first)

A **batch extraction** is an **asynchronous JOB**, not a synchronous `GET`. The caller (a cron, or a
REST `POST`) *requests* an extraction; the system returns a **job id immediately**; the heavy work —
pull from upstream, transform, write files — happens **off the request path on the Fly worker** (repo
non-negotiable **#4**: the serverless/request process holds no sockets, timers, or durable background
work); the caller later **polls status by job id** or is **notified** (SSE / webhook / a `list available
files` poll) when the job reaches `COMPLETE`; then it downloads the generated files. Every produced run
carries a **manifest** (run id, generated-at, the file list with row counts + checksums + per-file
`commercialOk` + attribution). Files are delivered **atomically** (write-temp-then-rename, or
complete-multipart) so a half-written file is **never** visible. Re-delivery is **idempotent** by
file-fingerprint/checksum so re-running a job never double-loads the consumer's warehouse, and
job-create is idempotent by an **idempotency key** so a retried `POST` never starts two extractions.
When an upstream provider is down, the run **skips** that file and records it as `unavailable` in the
manifest — it **never fabricates** a number to "look complete" (non-negotiable #1). This is exactly the
shape that JPMorgan's own `dataquery-sdk`, LSEG Tick History, Salesforce Data 360, and the modern
"S3-is-the-new-SFTP" lakehouse-delivery pattern all converge on; the rest of this doc is the *why* and
the *exactly-how*, with their primary docs cited inline.

The whole channel in one diagram:

```
   ┌──────────────┐    create (cron OR REST POST + Idempotency-Key)
   │  SCHEDULER    │ ───────────────────────────────────────────────►┐
   │ (cron-job.org │                                                   │
   │  / on-demand) │                                                   ▼
   └──────────────┘                                       ┌────────────────────────┐
                              poll status by job id        │  WORKER (Fly process)   │
   ┌──────────────┐ ◄──────────────────────────────────── │  QUEUED → RUNNING →      │
   │   CONSUMER    │           OR  SSE / webhook notify     │  (pull→transform→write) │
   │ (warehouse /  │ ◄──────────────────────────────────── │  → COMPLETE | FAILED     │
   │  analyst /    │                                        └───────────┬────────────┘
   │  agent tool)  │           download (presigned S3 etc.)             │ atomic write
   └──────┬───────┘ ◄───────────────────────────────────────┐          ▼
          │ checksum-dedup before load                       │   ┌──────────────┐
          ▼                                                   └── │ OBJECT STORE  │
   warehouse / cache  ◄──── manifest (run id, files,             │ + MANIFEST    │
                            row counts, checksums, commercialOk)  └──────────────┘
```

---

## 1. Why batch is a JOB, not a GET (the architectural fork)

### 1.1 The defining property: the work outlives the request

A synchronous read (`GET /quote/AAPL`) returns the answer *in the same HTTP round-trip*. A batch
extraction can take **minutes**: pull a month of tick data, normalize it, write 30 files. You cannot
hold an HTTP connection open for that — the client times out, a load balancer kills it at 30–60s, and on
a serverless platform the function is frozen the instant the response closes. So the batch channel
**inverts** the request: the `POST` doesn't return the *data*, it returns a **handle** (a job id) to work
that has only just *started*. This is the universal shape across every serious provider:

- **LSEG Tick History**: "each on-demand extraction starting a job that has a unique ID … Users can use a
  job ID to query the status of an extraction, list all extracted files, download an extraction result,
  and cancel a job."
  ([LSEG Tick History — On-Demand Jobs and Files Management](https://developers.lseg.com/en/article-catalog/article/tick-history-on-demand-jobs-and-files-management))
- **JPMorgan `dataquery-sdk`**: exposes `run_group_download` / `download_file` / `list_available_files` /
  `check_availability` — *availability is a first-class question you ask before you download*, which only
  makes sense if production is asynchronous and decoupled from delivery.
  ([jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk))
- **Salesforce Data 360 Bulk Ingestion**: "creating a job, uploading job data, and letting Salesforce
  take care of the rest" — a job with its own state machine (`Open → UploadComplete → InProgress →
  JobComplete`).
  ([Data 360 Bulk Ingestion](https://developer.salesforce.com/docs/data/data-cloud-int/references/data-cloud-ingestionapi-ref/c360-a-api-bulk-ingestion.html))

### 1.2 The "202 Accepted" contract

The HTTP verb for "I have accepted your request and will work on it asynchronously" is **`202 Accepted`**,
not `200 OK`. The body of a `202` is the **job resource** — its id and a status URL — not the data. This
is the [RFC 9110 §15.3.3](https://www.rfc-editor.org/rfc/rfc9110#name-202-accepted) semantic: *"The 202
(Accepted) status code indicates that the request has been accepted for processing, but the processing
has not been completed … The representation … SHOULD include an indication of the request's current
status and either a pointer to a status monitor or some estimate of when the user can expect the request
to be fulfilled."* The status monitor is the job id + a `GET /jobs/{id}` poll endpoint.

```python
# READ service (FastAPI on the request path) — accepts the extraction, returns a handle, returns FAST.
from fastapi import FastAPI, Header, Response, status
from pydantic import BaseModel

app = FastAPI()

class ExtractRequest(BaseModel):
    dataset: str
    start_date: str   # "2026-01-01"
    end_date: str     # "2026-01-31"
    format: str = "parquet"

class JobAccepted(BaseModel):
    job_id: str
    status: str           # "QUEUED"
    status_url: str       # "/jobs/<id>"

@app.post("/extractions", status_code=status.HTTP_202_ACCEPTED, response_model=JobAccepted)
async def create_extraction(
    req: ExtractRequest,
    response: Response,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),  # see §5
):
    job = await enqueue_extraction(req, idempotency_key)   # writes a JOB row, returns immediately
    response.headers["Location"] = f"/jobs/{job.id}"        # RFC 9110: pointer to the status monitor
    return JobAccepted(job_id=job.id, status=job.status, status_url=f"/jobs/{job.id}")
```

Note what this handler does **not** do: it does not pull from upstream, does not write a file, does not
block. It writes one JOB row (`QUEUED`) and returns. The actual extraction is the **worker's** job
(§3) — repo non-negotiable #4. If you ever find the extraction logic *inside* this handler, the channel
is built wrong: a Vercel/serverless instance will freeze on `res.end()` and the multi-minute pull will
be killed (non-negotiable #5).

### 1.3 Why not just stream the file back synchronously?

Two reasons, both fatal at scale:

1. **The producer is shared; the consumers are many.** The EOD US-equities file is computed *once* and
   read by *every* subscriber. Streaming it synchronously per request means recomputing/re-pulling per
   request — the opposite of compute-once-serve-many (§8). Batch writes the artifact **once** to object
   storage; N consumers download the *same bytes*.
2. **A connection is a liability.** Holding a socket for a multi-minute transfer ties the run's success
   to one fragile TCP connection and one un-restartable process. Batch decouples *production* (worker,
   retryable) from *delivery* (object store, resumable, presigned) — see the transport recipe.

The trade-off is **latency**: batch is not for "give me AAPL's price now" (that's the sync read channel,
a different reference). Batch is for "give me the whole January tick file" — bulk, scheduled, large. Know
which channel a feature belongs to *before* you build it.

---

## 2. Two ways a job is created: scheduled vs on-demand

The job lifecycle is identical once a job exists; what differs is **who pulls the trigger**.

### 2.1 The distinction, from the canonical source

LSEG draws the line precisely — memorize it, because it is the same line in our design:

> **Scheduled extractions** "use instrument lists, report templates and schedules that are stored on the
> server … As they are persisted on the server, they can be re-used again and again. A schedule can be
> executed one single time, or run on a recurring basis, and can be triggered at a specific time, or by
> data availability, like at market close, or after data corrections are available."
>
> **On Demand extractions** "use simplified high level API calls that create extractions on the fly. They
> do not have their equivalent in the GUI … The report begins running as soon as you submit the request."
>
> — [LSEG — REST API Tutorials, scheduled vs on-demand](https://developers.lseg.com/en/api-catalog/refinitiv-tick-history/refinitiv-tick-history-rth-rest-api/tutorials)

| | **Scheduled** | **On-demand** |
|---|---|---|
| Trigger | external cron / data-availability event | a REST `POST` from a user/agent |
| Definition | persisted server-side (reusable template) | ephemeral, created on the fly |
| Cardinality | one definition → many runs | one request → one run |
| Use in our line | the **shared daily feed** (EOD US/India equities, the AI briefing snapshot) | a user/analyst/agent says "extract Jan 2026 ticks for these 40 names" |
| Scale shape | compute-once-serve-many (§8) | one consumer, one artifact |
| Idempotency anchor | `(definition_id, run_date)` | the `Idempotency-Key` header (§5) |

### 2.2 Scheduled = the external cron, never an in-process timer

Repo non-negotiable #4 forbids the request/serverless process from holding a timer. So a *scheduled*
batch is an **external scheduler** (cron-job.org in Lumina; for this product line, an external cron or
Fly's scheduler) that hits a `CRON_SECRET`-guarded endpoint, which enqueues the run. The schedule lives
**outside** any request process.

```python
# WORKER (separate Fly app) — the CRON_SECRET-guarded trigger that the external scheduler hits daily.
import os, hmac
from fastapi import FastAPI, Header, HTTPException, status, Depends

worker = FastAPI()
CRON_SECRET = os.environ["CRON_SECRET"]

def require_cron(authorization: str = Header(...)) -> None:
    expected = f"Bearer {CRON_SECRET}"
    if not hmac.compare_digest(authorization, expected):     # constant-time compare
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad cron secret")

@worker.post("/cron/eod-equities", dependencies=[Depends(require_cron)])
async def trigger_eod():
    run_date = today_in_market_tz()
    # Idempotency anchor for a SCHEDULED run = (definition, run_date). If the cron double-fires
    # (network blip, scheduler retry), get_or_create returns the SAME job — never two runs (§5).
    job = await get_or_create_job(definition="eod-equities", run_date=run_date)
    return {"job_id": job.id, "status": job.status}
```

The "trigger by data availability" variant (LSEG's "at market close, or after data corrections are
available") is the *correct* trigger for market feeds — you don't want a fixed 16:05 ET if the close is
delayed or corrections land late. Implement it as the cron firing a **readiness check** first; if
upstream isn't ready, the run records `unavailable` for the not-yet-published files rather than pulling
garbage (§7).

### 2.3 On-demand = the `202` REST `POST` from §1.2

The on-demand path is the `POST /extractions` handler already shown. The agent tool layer (the
api-platform/agent skill, not this one) calls it when a user asks for a custom extraction; the handler
enqueues and returns the job id; the agent then polls or subscribes. Crucially, **the agent never holds
the connection open waiting** — it gets a job id back and checks status, exactly like a human would.

---

## 3. The job lifecycle (the state machine)

### 3.1 The canonical states

Every batch system runs essentially the same state machine. The two reference state-sets:

**LSEG Tick History** job statuses: `NotStarted`, `InProgress`, `Completed`, `Error`,
`PendingCancellation`, `Canceled`, `Purged`
([LSEG — Jobs and Files Management](https://developers.lseg.com/en/article-catalog/article/tick-history-on-demand-jobs-and-files-management)).

**Salesforce Data 360 Bulk Ingestion** job states, verbatim
([Data 360 Bulk Ingestion](https://developer.salesforce.com/docs/data/data-cloud-int/references/data-cloud-ingestionapi-ref/c360-a-api-bulk-ingestion.html)):
- `Open` — "Job is created and ready to accept data uploads."
- `UploadComplete` — "All data is uploaded, the job is closed and ready for processing."
- `InProgress` — "The system is actively processing the uploaded data."
- `JobComplete` — "Processing completed successfully and data is available."
- `Failed` — "Processing failed. Check error details."
- `Aborted` — "Job was manually aborted."

Our canonical state machine, distilled from both:

```
                         create (cron OR POST)
                                 │
                                 ▼
                            ┌─────────┐   cancel
                            │ QUEUED   │ ─────────► PENDING_CANCEL ──► CANCELED
                            └────┬────┘
                  worker picks up │
                                 ▼
                            ┌─────────┐   cancel
                            │ RUNNING  │ ─────────► PENDING_CANCEL ──► CANCELED
                            └────┬────┘
              all files written  │  unrecoverable error
              + manifest sealed  │  (after retries exhausted)
                    ┌────────────┴────────────┐
                    ▼                         ▼
              ┌──────────┐              ┌──────────┐
              │ COMPLETE  │              │  FAILED   │
              └────┬─────┘              └──────────┘
                   │ retention window expires
                   ▼
              ┌──────────┐
              │ EXPIRED   │   (files purged; LSEG's "Purged")
              └──────────┘
```

The states and the *one-way* transitions are the contract. Three rules that fall out of it:

1. **Terminal states are terminal.** `COMPLETE`, `FAILED`, `CANCELED`, `EXPIRED` never transition back.
   A consumer that sees `COMPLETE` can trust the manifest is sealed and the files are atomically present.
2. **`COMPLETE` means the manifest is sealed AND every listed file is atomically visible.** The job does
   not flip to `COMPLETE` until the last file's atomic-rename/complete-multipart has succeeded and the
   manifest is written (§4, §6). A consumer must never act on a `RUNNING` job's partial outputs.
3. **`FAILED` is reached only after retries are exhausted.** A transient upstream 503 inside `RUNNING`
   does not fail the job — the worker retries (§3.3). `FAILED` is the *durable, give-up* state and pages
   a human.

### 3.2 Status query by job id

The consumer polls `GET /jobs/{id}`. LSEG's endpoint surface is the reference shape — note it exposes
*both* "all jobs" and *filtered* views, which matters at scale (don't make a consumer page through every
historical job to find the active one):

| LSEG endpoint | Purpose |
|---|---|
| `GET /Jobs/Jobs` | "Return all Jobs" |
| `GET /Jobs/JobGetActive` | "Returns the active (in progress) jobs" |
| `GET /Jobs/JobGetCompleted` | "Returns the completed jobs" |
| `GET /Jobs/Jobs({JobId})` | "Returns a single job" |

([LSEG — Jobs and Files Management](https://developers.lseg.com/en/article-catalog/article/tick-history-on-demand-jobs-and-files-management))

Our equivalent:

```python
class JobStatus(BaseModel):
    job_id: str
    status: str               # QUEUED | RUNNING | COMPLETE | FAILED | PENDING_CANCEL | CANCELED | EXPIRED
    created_at: str
    started_at: str | None
    finished_at: str | None
    manifest_url: str | None  # populated ONLY when status == COMPLETE
    error: str | None         # populated ONLY when status == FAILED
    expires_at: str | None    # retention horizon (§3.4)

@app.get("/jobs/{job_id}", response_model=JobStatus)
async def get_job(job_id: str):
    job = await load_job(job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such job")
    return job.to_status()
```

**Polling discipline (consumer side).** Poll with backoff, not a tight loop — a status poll is cheap but
not free, and a thousand consumers polling every 200ms is a self-inflicted DDoS. The LSEG file-download
optimization guide implicitly endorses this by noting time-of-day load effects (downloads "take ~20%
longer" between 8–14 GMT) — the system is shared, so be polite
([LSEG — Optimize Tick History file downloads](https://developers.lseg.com/en/article-catalog/article/how-optimize-tick-history-file-downloads-python-and-other-languages)).
Prefer **push notification** (§7) over polling when available; fall back to polling with exponential
backoff capped at a sane interval.

### 3.3 The RUNNING phase, in detail (what the worker actually does)

`RUNNING` is the only phase that does real work. It is a sub-pipeline, and each sub-step is retryable and
must be **resumable** (a worker can be killed mid-run by a deploy):

```
RUNNING:
  for each file in the run's plan:
     1. PULL  upstream slice (paginated, rate-limited, retried with backoff)
            └─ provider down after retries → mark file `unavailable`, CONTINUE (§7) — do NOT fail the job
     2. TRANSFORM/normalize to canonical schema (the data-normalization-tet skill owns this)
     3. WRITE atomically: stream to a TEMP key, compute checksum + row count while streaming,
            then atomic-rename / complete-multipart to the FINAL key (§4)
     4. APPEND the file's entry (path, rows, checksum, commercialOk, attribution) to the in-progress manifest
  SEAL the manifest (write it atomically, LAST), then transition job → COMPLETE
```

Retry policy for step 1 mirrors what the JPM SDK exposes as a first-class knob — `max_retries` with
exponential backoff between a floor and ceiling delay:

```python
# JPM dataquery-sdk exposes retry as a parameter; SSE reconnects use exponential backoff
# between reconnect_delay (5s) and max_reconnect_delay (60s). We mirror the shape for PULL.
result = await dq.run_group_download_async(
    group_id="JPMAQS_GENERIC_RETURNS",
    start_date="20250101", end_date="20250131",
    destination_dir="./data",
    max_retries=3,                       # ← per-file pull retry
)
```
([jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk))

The worker **must not** hold the whole month in RAM to write it — stream slice-by-slice. And the *write*
is the atomic step that protects consumers (§4). The PULL being retryable and the WRITE being atomic are
what let a killed worker simply **re-run the whole job idempotently** (§5) without corrupting anything.

### 3.4 Retention: jobs and files expire

A finished job is not kept forever — the files cost storage and the job rows accumulate. The reference
windows:

- **LSEG**: "on-demand extractions expire after **3 days**," after which files are automatically removed;
  asynchronous **jobs** persist for "a maximum of **seven days**."
  ([LSEG — Jobs and Files Management](https://developers.lseg.com/en/article-catalog/article/tick-history-on-demand-jobs-and-files-management))
  Note the *split*: the **files** (the heavy bytes) expire faster (3d) than the **job metadata** (7d) —
  you can still *see* that a job ran and what it produced after the bytes are gone.

So our design has **two retention horizons**:

| Artifact | Horizon (tune per dataset) | What expiry does |
|---|---|---|
| **Generated files** (the bytes) | short (e.g. 3–7 days for on-demand; longer for the canonical daily feed) | object-store lifecycle rule deletes them; job → `EXPIRED` |
| **Job + manifest metadata** | longer (e.g. 30–90 days) | kept for audit / "what did we ship and when" / re-request decisions |

Implement file expiry with the **object-store's own lifecycle rule**, not an app timer (non-negotiable
#4). On S3, a lifecycle rule with `Expiration` deletes objects after N days, and a separate
`AbortIncompleteMultipartUpload` rule reclaims orphaned in-progress uploads — AWS explicitly recommends
"configure a lifecycle rule to delete incomplete multipart uploads after a specified number of days by
using the `AbortIncompleteMultipartUpload` action"
([AWS — Multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)).
The job-metadata expiry is a worker/cron sweep (a scheduled `DELETE FROM jobs WHERE finished_at < …`).

State the retention window of every batch feature **in writing** (it's part of the output contract). A
consumer that downloads on a weekly cadence against a 3-day file horizon will silently miss data — the
horizon is a contract, not an implementation detail.

### 3.5 Cancellation

A `RUNNING` or `QUEUED` job can be canceled. The reference behavior (LSEG): send `HTTP DELETE` to the
job's monitor URL → "The response status becomes `204 No Content`, and the job status changes to
`PendingCancellation`" → eventually `Canceled`
([LSEG — Jobs and Files Management](https://developers.lseg.com/en/article-catalog/article/tick-history-on-demand-jobs-and-files-management)).
The two-step (`PENDING_CANCEL` → `CANCELED`) exists because the worker may be mid-pull; cancellation is a
**request** the worker honors at the next safe checkpoint (between files), not an instant kill — and
crucially it leaves no half-written file visible (§4 guarantees that anyway). Idempotency: canceling an
already-canceled or already-complete job is a no-op (return the current terminal state), never an error
that double-acts.

```python
@app.delete("/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_job(job_id: str):
    job = await load_job(job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    if job.status in TERMINAL:          # COMPLETE/FAILED/CANCELED/EXPIRED → idempotent no-op
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    await request_cancel(job_id)        # → PENDING_CANCEL; worker honors it at the next file boundary
    return Response(status_code=status.HTTP_204_NO_CONTENT)
```

---

## 4. Atomic delivery: a half-written file is NEVER visible

This is the single most important invariant of the channel. A consumer that reads a file **must** see
either the *complete* file or *no* file — never a truncated, mid-write byte stream. If a consumer can see
a half-written file, every downstream number it computes is wrong, silently.

### 4.1 The principle, from the lakehouse-delivery canon

> "files can be **atomically exposed to customers (no partial uploads)**."
> — [Materialized View — *S3 Is the New SFTP*](https://materializedview.io/p/s3-is-the-new-sftp)

The same article frames *why batch beats streaming for this*: "Data is loaded in batch, rather than
streamed on web sockets or polled through HTTP APIs" and "access can be managed centrally in the catalog"
— atomic exposure is the property that makes a batch artifact safe to hand to N consumers at once.

### 4.2 Mechanism A — write-temp-then-rename (POSIX / single filesystem / SFTP landing)

The classic atomic-publish pattern: write to a **temporary name**, then **rename** to the final name.
`rename(2)` is atomic on a POSIX filesystem — the final path either points at the old inode or the new
one, never a partial. A consumer scanning the directory for `*.parquet` never sees the in-progress
`.tmp`. Two reinforcing conventions:

1. **Dot-prefix or `.tmp` the in-progress file**, then rename. Openbridge's filename rules even *bless*
   this by *forbidding* consumers from delivering dot-prefixed files — they're treated as hidden/work
   files: the doc lists "hidden files (dot-prefixed)" among names to avoid for *final* delivery
   ([Openbridge — Batch File Delivery Tips & Best Practices](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices)).
   So `.eod-2026-06-24.parquet.tmp` is invisible to a `*.parquet` glob until renamed.
2. **A `_SUCCESS` / done-marker file**, written *last*, signals the whole *run* is complete (the
   Hadoop/Spark convention). Consumers wait for `_SUCCESS` before reading the directory. The manifest
   (§5) is our richer `_SUCCESS`: its presence == the run is sealed.

```python
import os, tempfile, hashlib
from pathlib import Path

def atomic_write(dest: Path, write_body) -> tuple[str, int]:
    """Stream into a temp file on the SAME filesystem, fsync, then os.replace() (atomic rename).
    Returns (sha256_hex, row_count). A consumer globbing dest's parent never sees the temp."""
    h = hashlib.sha256()
    rows = 0
    # NamedTemporaryFile in the SAME directory → rename is a metadata op on one filesystem (atomic).
    fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            for chunk, n in write_body():        # generator yields (bytes, rows_in_chunk)
                h.update(chunk); rows += n
                f.write(chunk)
            f.flush(); os.fsync(f.fileno())       # durability before the rename
        os.replace(tmp, dest)                     # ATOMIC publish: dest now fully present or untouched
    except BaseException:
        os.unlink(tmp)                            # failed run leaves NO partial behind
        raise
    return h.hexdigest(), rows
```

`os.replace` is the Python binding for the atomic rename (it overwrites the destination atomically on
both POSIX and Windows). The `try/except → unlink` guarantees a crashed run leaves **no** orphan visible
to a consumer — only an invisible `.tmp` that a lifecycle sweep reaps.

### 4.3 Mechanism B — S3 multipart complete (object store)

On object storage there is no `rename`; atomicity comes from **multipart upload**. The object **does not
exist** until `CompleteMultipartUpload` succeeds — and AWS is explicit that in-progress parts are
**invisible**:

> "Upon receiving the complete multipart upload request, Amazon S3 constructs the object from the uploaded
> parts, and you can access the object just as you would any other object in your bucket."
> … "An in-progress multipart upload is an upload that you have initiated, but have not yet completed or
> stopped."
> — [AWS — Multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)

A `ListObjects` / `GET` against the final key returns **nothing** until `CompleteMultipartUpload`. So the
publish is atomic by construction: parts accumulate invisibly, then one `Complete` call flips the object
into existence, fully formed — "Amazon S3 creates an object by concatenating the parts in ascending order
based on the part number"
([AWS — Multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)).

Three details that matter for *correct* atomic delivery on S3:

1. **The completed object's ETag is a checksum-of-checksums**, *not* an MD5 of the bytes: "once the
   multipart upload is complete and all parts are consolidated, all parts belong to one ETag as a checksum
   of checksums" and "This ETag is not necessarily an MD5 hash of the object data." So **do not use the
   ETag as your content fingerprint** for dedup (§5) — compute and store your *own* whole-object checksum
   in the manifest. (You *can* ask S3 to validate a full-object checksum you supply: "S3 validates the
   object integrity server-side … If the two values don't match, Amazon S3 fails the request with a
   `BadDigest` error." Use that as a transport integrity check, separate from your manifest fingerprint.)
   ([AWS — Multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html))
2. **Conditional write to prevent clobbering a prior run's file.** S3 supports a conditional
   `CompleteMultipartUpload`/`PutObject` that "validate[s] that there is no existing object with the same
   key name already in your bucket while uploading" — use it so a re-run that *shouldn't* overwrite (a new
   immutable run id, §4.4) fails loudly instead of silently clobbering
   ([AWS — Multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)).
3. **Abort + lifecycle reclaims partials.** A crashed worker leaves an *in-progress* upload, not a partial
   object — invisible to consumers, but it costs storage until aborted. `AbortMultipartUpload` (and the
   `AbortIncompleteMultipartUpload` lifecycle rule) reclaim it
   ([AWS — Multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)).

```python
# S3 atomic publish via multipart. The object key DOES NOT EXIST to consumers until complete().
import boto3
s3 = boto3.client("s3")

def s3_atomic_put(bucket: str, key: str, body_iter, part_size=8 * 1024 * 1024):
    mpu = s3.create_multipart_upload(Bucket=bucket, Key=key, ChecksumAlgorithm="SHA256")
    upload_id = mpu["UploadId"]
    parts, part_no = [], 1
    try:
        for part_bytes in chunked(body_iter, part_size):
            r = s3.upload_part(Bucket=bucket, Key=key, UploadId=upload_id,
                               PartNumber=part_no, Body=part_bytes, ChecksumAlgorithm="SHA256")
            parts.append({"PartNumber": part_no, "ETag": r["ETag"],
                          "ChecksumSHA256": r["ChecksumSHA256"]})  # record per-part (required for checksums)
            part_no += 1
        # ← object still INVISIBLE here. This one call makes it appear, fully formed:
        s3.complete_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id,
                                     MultipartUpload={"Parts": parts})
    except BaseException:
        s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)  # leave NO partial
        raise
```

> **Checksum caveat from the docs:** "If you're using a multipart upload with **Checksums**, the part
> numbers for each part upload … must use consecutive part numbers and begin with 1." Non-consecutive part
> numbers with checksums → "Amazon S3 generates an `HTTP 500 Internal Server` error"
> ([AWS — Multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)).
> So number parts `1, 2, 3, …` contiguously when you want per-part checksums (we do).

### 4.4 Immutable run ids beat in-place overwrite

The cleanest atomic-delivery design avoids overwriting a *live* key at all: each run writes to a
**run-scoped, immutable path** and the "latest" pointer is flipped atomically last.

```
s3://feed/eod-equities/run=2026-06-24T20:05:11Z/us-equities.parquet   ← immutable, write-once
s3://feed/eod-equities/run=2026-06-24T20:05:11Z/_manifest.json        ← sealed last
s3://feed/eod-equities/latest -> (manifest points at the run dir)     ← consumers read this
```

Benefits: (a) a consumer reading `run=…` never races a re-write — the path is write-once; (b) re-running
a job produces a *new* run id, so the old artifact is untouched (rollback is trivial — repoint `latest`);
(c) the manifest, written last, is the atomic commit point for the *whole run* (the `_SUCCESS` of §4.2).
This is the lakehouse/Iceberg "atomic catalog commit" idea ("a shared S3 bucket managed by an Iceberg
catalog … files can be atomically exposed") reduced to its essence
([Materialized View — *S3 Is the New SFTP*](https://materializedview.io/p/s3-is-the-new-sftp)).

---

## 5. The manifest: the run's contract + the dedup anchor

### 5.1 What it is and why it exists

A **manifest** is the machine-readable index of a run: it names every file produced, with enough metadata
for a consumer to (a) know the run is complete, (b) verify integrity, (c) know what it's licensed to do,
and (d) **deduplicate** against prior runs. Openbridge's manifest is the canonical minimal form:

> "a manifest of files is maintained in the source system. This manifest would identify the **files to be
> delivered and their state (success, failure, pending)**." It enables recovery: "attempt a redeliver for
> any file that had not received a successful '226' code."
> — [Openbridge — Batch File Delivery Tips & Best Practices](https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices)

We extend it for a *financial-data* product line — every file carries its **provenance** (the
`commercialOk` gate, repo non-negotiable #2 + the commercial-ok-gate rule) and its **row count** (so a
consumer can detect a truncated/short file even after an "atomic" write succeeded against a partial pull).

### 5.2 The manifest schema (our canonical form)

```jsonc
{
  "schema_version": 1,
  "run_id": "2026-06-24T20:05:11Z",          // immutable; also the run-dir name (§4.4)
  "definition": "eod-equities",               // null for on-demand runs
  "job_id": "job_9f2c...",                    // the job that produced this run
  "generated_at": "2026-06-24T20:09:42Z",     // when the manifest was sealed
  "market_date": "2026-06-24",                // the business date the data is FOR (≠ generated_at)
  "status": "COMPLETE",                       // COMPLETE | PARTIAL  (PARTIAL = some files unavailable, §7)
  "files": [
    {
      "path": "us-equities.parquet",
      "rows": 11423,                          // row count — consumer asserts this after download
      "bytes": 4823914,
      "checksum": { "algo": "sha256", "value": "9b1c…e0" },  // OUR fingerprint (NOT the S3 ETag, §4.3)
      "format": "parquet",
      "commercialOk": false,                  // the licensing gate, DEFAULT false (non-negotiable #2)
      "attribution": "Source: <provider>. <required notice>.", // rendered where ToS requires
      "provider": "<fetch-path identifier>",  // the fetch path the license attaches to
      "state": "success"                      // success | unavailable | failed
    },
    {
      "path": "india-equities.parquet",
      "rows": 0,
      "checksum": null,
      "commercialOk": false,
      "state": "unavailable",                 // provider was down — recorded, NOT fabricated (§7)
      "reason": "upstream 503 after 3 retries"
    }
  ]
}
```

Field-by-field rationale:

| Field | Why it's load-bearing |
|---|---|
| `run_id` + `generated_at` | identity + freshness; a consumer caches by `run_id`, detects staleness by `generated_at` |
| `market_date` ≠ `generated_at` | the data is *for* a business date but *produced* later (T+1). Conflating them is a classic bug. |
| `files[].rows` | post-download assertion: `assert downloaded_rows == manifest.rows` catches a truncated/short pull even when the atomic write "succeeded" against a partial upstream |
| `files[].checksum` | the **dedup anchor** (§5.3) AND the integrity check. **Our own** SHA-256, not the S3 ETag (§4.3). |
| `files[].commercialOk` | the licensing verdict for *this fetch path*. Default `false`. A composite file that ingests any RED input is RED (the contamination rule). |
| `files[].attribution` | the CC-BY / required notice the consumer must render. Travels *with* the data. |
| `files[].state` | `success` / `unavailable` / `failed` — makes partial runs honest and recoverable (§7) |
| `status: PARTIAL` | the run completed but not every file is present — the consumer knows not to treat absence as zero |

### 5.3 The checksum is the idempotency anchor for delivery

The manifest checksum is what makes **re-delivery idempotent** — the single most important consumer-side
property. The mechanism, straight from event-driven canon:

> "Idempotency is a property of an operation that allows it to be applied multiple times without changing
> the result." Systems must dedup because events come "with at-least-once delivery guarantee … each event
> reaches its destination but may arrive multiple times." The dedup mechanism: "embedding unique
> identifiers … if you try to insert the same Id twice … it will fail due to a duplicate key exception."
> Where "a naturally unique identifier is available, it is generally preferred."
> — [Cockroach Labs — Idempotency and ordering in event-driven systems](https://www.cockroachlabs.com/blog/idempotency-and-ordering-in-event-driven-systems/)

For file delivery, the **content checksum IS the natural unique identifier**. A consumer keeps a table of
ingested checksums; before loading a file it checks "have I already loaded this exact content?" — if yes,
skip. So re-delivering the same file (cron double-fired, consumer re-polled, network retried the
download) **never double-loads the warehouse**:

```python
# CONSUMER side: checksum-dedup before loading into the warehouse.
def ingest_if_new(file_entry, local_path, db):
    digest = sha256_of(local_path)
    if digest != file_entry["checksum"]["value"]:
        raise IntegrityError(f"checksum mismatch — file corrupt or wrong: {file_entry['path']}")
    # Natural-id dedup: the content checksum is the unique key. Re-delivery is a no-op.
    if db.already_ingested(digest):
        log.info("skip %s — already loaded (checksum %s)", file_entry["path"], digest[:12])
        return
    rows = load_parquet(local_path)
    assert len(rows) == file_entry["rows"], "row-count mismatch vs manifest"   # short-file guard
    db.upsert(rows, key="business_key")        # upsert, not blind insert (§5.4)
    db.mark_ingested(digest)                    # remember it — idempotency state
```

> **The Salesforce anti-pattern, named.** Data 360 "tracks which files it has already processed by their
> **filenames**, and if you update the contents of a file without changing its name, Data Cloud may not
> detect or process these changes"
> ([Salesforce Data 360 ingestion](https://developer.salesforce.com/docs/data/data-cloud-int/references/data-cloud-ingestionapi-ref/c360-a-api-bulk-ingestion.html)).
> **Filename-based dedup is a trap**: same name + new content → the change is silently missed; new name +
> same content → the same data is double-loaded. **Dedup by content checksum, never by filename.** The
> filename is for humans; the checksum is for the machine.

### 5.4 Upsert, not insert — the warehouse-side idempotency partner

Even with checksum-dedup, the *load* should be an **upsert keyed by a business key**, not a blind insert,
so that a *corrected* re-run (same logical rows, new values) converges instead of duplicating. Salesforce
Data 360's model is the reference: "Use unique business keys (e.g. `Contact.ExternalId`) to dedupe or
upsert … Upsert updates existing records if the primary key matches, or adds new ones if it doesn't"
([Salesforce Data 360 ingestion](https://developer.salesforce.com/docs/data/data-cloud-int/references/data-cloud-ingestionapi-ref/c360-a-api-bulk-ingestion.html)).
Caveat from the same source: their upsert is "a **full replace. Patch semantics aren't supported**" — so
a partial file replaces the whole row, not just the changed columns. Know your store's upsert semantics
(TimescaleDB `INSERT … ON CONFLICT DO UPDATE` is the analog in our line — see the
`timescaledb-timeseries` skill). **Two idempotency layers, both required**: checksum-dedup avoids
*re-processing the same bytes*; business-key upsert makes *re-processed corrected rows* converge.

### 5.5 Idempotent job-create (the producer side)

The mirror of consumer dedup is **producer dedup**: a retried `POST /extractions` must not start two
extractions. Use an **idempotency key** — the same primitive Stripe popularized: the client sends
`Idempotency-Key: <uuid>`; the server stores `(key → job_id)`; a repeat with the same key returns the
*same* job, never a new one.

```python
async def enqueue_extraction(req: ExtractRequest, idem_key: str):
    existing = await jobs_repo.find_by_idem_key(idem_key)
    if existing is not None:
        return existing                       # retried POST → SAME job. No second extraction.
    job = Job(id=new_id(), status="QUEUED", request=req, idem_key=idem_key)
    try:
        await jobs_repo.insert_unique(job)    # UNIQUE(idem_key) — DB enforces the dedup (Cockroach pattern)
    except UniqueViolation:                    # raced a concurrent identical POST → load the winner
        return await jobs_repo.find_by_idem_key(idem_key)
    return job
```

For *scheduled* runs the natural idempotency key is `(definition_id, run_date)` (§2.2) — a double-firing
cron `get_or_create`s the same job. Either way the rule is identical to the consumer's: **a unique key +
a DB uniqueness constraint** turns "at-least-once trigger" into "exactly-once effect"
([Cockroach Labs — Idempotency and ordering](https://www.cockroachlabs.com/blog/idempotency-and-ordering-in-event-driven-systems/)).

---

## 6. Where the manifest is written, and when (the seal)

The ordering rule that ties §4 and §5 together:

1. Write every **data file** atomically (temp→rename or multipart-complete). Each becomes individually
   visible as it completes, but a consumer is told **not to read the run** until the manifest exists.
2. Write the **manifest last**, atomically. Its appearance is the **single commit point** of the whole
   run — the `_SUCCESS` marker (§4.2). Before the manifest, the run is "in progress"; after, it's sealed.
3. **Only then** flip the job to `COMPLETE` and (for a shared feed) repoint `latest` → the new run dir.

A consumer's algorithm is therefore: *find the manifest → verify `status` → for each file, download →
checksum-verify → row-count-assert → dedup → upsert*. It **never** enumerates the run directory and reads
whatever files happen to be there (that races a `RUNNING` job). The manifest is the contract; the bytes
are only trustworthy through it.

```
WRITE order (worker):            READ order (consumer):
  file_1.parquet  (atomic)         GET _manifest.json   ← if absent → run not ready, back off
  file_2.parquet  (atomic)         for f in manifest.files:
  …                                    GET f.path
  _manifest.json  (atomic, LAST) ──►   verify f.checksum, assert f.rows
  job → COMPLETE                       dedup by checksum, upsert by business key
  latest → run_dir                  done
```

If the worker dies after `file_2` but before the manifest, there is **no manifest**, so no consumer ever
acts on the half-run; the next job run (idempotent, §5) produces a *new* run id and a complete manifest;
a lifecycle sweep reaps the orphaned files of the dead run. The whole thing is crash-safe by construction.

---

## 7. Notification: how a consumer learns a run is ready

Three mechanisms, in increasing push-iness. Support at least one; the JPM SDK supports all three shapes.

### 7.1 Poll "list available files" (the floor — always works)

The consumer periodically asks "what's available?" This is the JPM SDK's `list_available_files` /
`check_availability` and LSEG's `/Extractions/ExtractedFiles` listing:

```python
# JPM dataquery-sdk — availability is a first-class query (you ask BEFORE downloading).
available = await dq.list_available_files_async(
    group_id="JPMAQS_GENERIC_RETURNS", start_date="20250101", end_date="20250131")
info = await dq.check_availability_async(
    file_group_id="JPMAQS_GENERIC_RETURNS", file_datetime="20250115")
```
([jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk))

LSEG's equivalent: `GET /Extractions/ExtractedFiles` "List all extracted files with paging," then
`GET /Extractions/ExtractedFiles('<ID>')/$value` to download
([LSEG — Jobs and Files Management](https://developers.lseg.com/en/article-catalog/article/tick-history-on-demand-jobs-and-files-management)).
In our design, "list available" == "list runs whose manifest exists." Poll with backoff (§3.2). This is
the floor: it always works, but wastes requests and adds latency between "ready" and "noticed."

### 7.2 SSE auto-download (JPM's model — a long-lived push stream)

The JPM SDK's `auto_download` opens a **Server-Sent Events** stream: the server pushes "a new file is
ready" events; the client downloads on each event. The mechanics worth copying:

- **Initial backfill on startup** (`initial_check=True` default): "on startup, checks current-day
  availability to prevent missing already-published files" — i.e. don't miss files published *before* you
  subscribed.
- **Event replay via persisted cursor** (`enable_event_replay=True` default): "the last SSE event id is
  persisted to `<destination>/.sse_state/sse_<fingerprint>.json`, so a restart resumes from where the
  previous session stopped" — the SSE `Last-Event-ID` reconnection mechanism, so a dropped connection
  doesn't lose events.
- **Reconnect with backoff**: "SSE reconnects use exponential backoff between `reconnect_delay` (5s) and
  `max_reconnect_delay` (60s)," plus a `heartbeat_timeout` (e.g. 90s) to force a reconnect when idle.
- **Observable**: `manager.get_stats()` returns "notifications received, files downloaded / skipped /
  failed, the last event id, and a bounded ring of recent errors."

([jpmorganchase/dataquery-sdk](https://github.com/jpmorganchase/dataquery-sdk))

```python
# JPM dataquery-sdk — SSE auto-download manager (the push model).
manager = await dq.auto_download_async(
    group_id="JPMAQS_GENERIC_RETURNS",
    destination_dir="./downloads",
    file_group_id=["FG_ABC", "FG_DEF"],   # subscribe to a subset
)
# … later …
stats = manager.get_stats()   # notifications, downloaded/skipped/failed, last_event_id, recent errors
```

**The repo constraint, named.** SSE is a long-lived socket. Per non-negotiable #4, a long-lived
push/socket **cannot live on the serverless/request process** — the SSE-emitting endpoint (the
notification stream) belongs on the **Fly worker**, exactly as Lumina's live-price socket does. The
consumer's SSE *client* can run anywhere durable (the worker, a sidecar). Do not put an SSE producer on a
Vercel-class function; it will be frozen on response close (#5).

### 7.3 Webhook (push to a consumer-supplied URL)

The inverse of SSE: instead of the consumer holding a stream open, the producer `POST`s a small "run
ready" event to a URL the consumer registered. Webhooks are cheaper (no held connection) but require the
same **at-least-once + idempotent** discipline as everything else: the producer retries the webhook on
non-2xx, so the **consumer's handler must be idempotent** (dedup by `run_id`) — a re-delivered webhook
must not trigger a second ingest
([Cockroach Labs — Idempotency and ordering](https://www.cockroachlabs.com/blog/idempotency-and-ordering-in-event-driven-systems/)).
Sign the webhook (HMAC) so the consumer can verify it's genuinely from us.

```python
# PRODUCER (worker) — fire a signed webhook when a run seals. Retried on failure; consumer must dedup.
async def notify_webhook(consumer_url: str, run: ManifestSummary, secret: str):
    body = run.model_dump_json().encode()
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    for attempt in range(5):                       # at-least-once: retry on non-2xx / timeout
        try:
            r = await client.post(consumer_url, content=body,
                                  headers={"X-Signature": sig, "X-Run-Id": run.run_id})
            if r.status_code < 300:
                return
        except httpx.TransportError:
            pass
        await asyncio.sleep(min(60, 2 ** attempt))  # exponential backoff (same shape as JPM SSE reconnect)
```

### 7.4 Choosing

| Mechanism | Latency | Cost | Use when |
|---|---|---|---|
| Poll "list available" | high (poll interval) | wasted requests | the floor; always available; a consumer that already runs a periodic job |
| **SSE** | low | a held socket (worker-only, #4) | a long-running consumer that wants near-real-time delivery (JPM's default) |
| **Webhook** | low | a registered URL + signing | a serverless/lambda consumer that can't hold a socket |

---

## 8. Scale: the compute-once-serve-many rule for shared feeds

### 8.1 The numbers this channel must survive

Reference scale for a market-data batch feed is **hundreds of files per day** and **terabytes of bytes**.
Concrete anchors from the field:

- A single LSEG tick file in the download-optimization study was **323 MB compressed / 5.6 GB
  uncompressed**, with **900+ downloads** measured, averaging ~5 minutes each
  ([LSEG — Optimize Tick History file downloads](https://developers.lseg.com/en/article-catalog/article/how-optimize-tick-history-file-downloads-python-and-other-languages)).
- Large market-data providers "parse, index and store up to **10 TB of raw data every day**" and deliver
  T+1 update products via SFTP
  ([web search synthesis — market-data delivery solutions](https://www.lseg.com/en/data-analytics/market-data/data-feeds)).

A daily feed across US + India equities + indices + the major datasets is easily **350+ files/day**
once you fan out by market, asset class, and dataset. The channel must not melt at that volume.

### 8.2 The rule: produce once, serve many

A *scheduled* shared feed (the EOD file, the daily AI briefing snapshot) is the canonical
**compute-once-serve-many** surface. The expensive work — pull from upstream, normalize, write — happens
**once per run**, on the worker. The artifact is written **once** to object storage. Then **N consumers
download the same immutable bytes**. You never re-pull or re-compute per consumer.

This is the same discipline as Lumina's cron-warmed finance cards (`getOrRefresh` + stale-while-revalidate
+ in-flight de-dupe — "print the flyer once, don't hand-write it per user", per `product-at-scale.md`),
applied to *files* instead of *cached JSON*. The mechanism here is even cleaner because the artifact is
**immutable** (a sealed run, §4.4): no cache invalidation, no SWR — a run id is forever the same bytes, so
a consumer caches it indefinitely and a CDN/object-store fronts the download fan-out.

| If you do this… | At 350 files/day × N consumers it… |
|---|---|
| Re-pull upstream per consumer download | hammers the upstream provider (rate-limited, possibly RED-licensed per-call), multiplies cost N× | 
| Stream the file synchronously per request | ties each delivery to one fragile socket; no resumability; serverless freeze | 
| **Produce one immutable run, serve via presigned object-store URLs** | upstream is hit **once**; the object store/CDN absorbs the N-way fan-out; downloads are resumable | 

### 8.3 The worker, not the request path (restating #4 for scale)

All of this — the pull, the normalize, the write, the compression, the retention sweep — is **worker /
cron** work. None of it touches the FastAPI request path (non-negotiable #4; the
`python-fastapi-data-service` skill's *background-work-and-the-worker-boundary* reference is the law).
The request path does exactly two cheap things: **accept** an on-demand extraction (`202` + job id, §1.2)
and **serve job status / a presigned download URL**. The heavy 5-minute, 5-GB pull is never inline.

### 8.4 Direct-to-store download, not through your API (the delivery half)

At scale you must **not** proxy gigabytes of file bytes through your own API server — that turns your read
service into a bandwidth bottleneck. The reference move is **presigned/direct object-store download**: the
API returns a short-lived signed URL; the consumer downloads **directly from the object store**, never
through your app. LSEG's "X-Direct-Download" does exactly this and ranks it the #1 optimization:

> "The REST API allows you to download extracted data faster by retrieving them **directly from the AWS
> (Amazon Web Services) cloud in which they are hosted**." Enable with `X-Direct-Download: true` → "a
> response with HTTP status **302 (redirect)** will be returned" pointing at a pre-signed S3 URL. "Using
> AWS will give you the **greatest performance gain**."
> — [LSEG — Optimize Tick History file downloads](https://developers.lseg.com/en/article-catalog/article/how-optimize-tick-history-file-downloads-python-and-other-languages)

(One sharp edge from that doc, worth carrying into the transport recipe: some clients like `curl` "include
the Authorization header in the redirected request, causing a 400 error" — the fix is to extract the
pre-signed URL from the 302 `Location` and GET it *without* auth. The presigned URL carries its own auth.)
The *transport* mechanics (presigned URL generation, gzip `Accept-Encoding`, range/resume) are the
`patterns-*` transport recipe's job — this doc only fixes the **architectural** rule: **deliver direct
from the store, not through the API**.

---

## 9. Partial failure: skip-not-fake (the finance non-negotiable, at the channel level)

When one provider is down, the run does **not** fail wholesale, and it absolutely **does not fabricate** a
number to make the file "look complete." It records the missing slice as `unavailable` in the manifest and
seals the run as `PARTIAL` (§5.2). This is repo non-negotiable #1 (*never invent a finance number; failed
tools return typed `unavailable`/`needsKey`, never fabricated data*) expressed at the **batch-channel**
layer.

The decision table for a per-file pull failure inside `RUNNING`:

| Situation | Wrong (fabricate / fail-all) | Right (skip-not-fake) |
|---|---|---|
| Provider 503 after retries | carry yesterday's price forward into today's file; OR fail the whole run | file `state: "unavailable"`, `rows: 0`, `reason: "upstream 503"`; run `status: PARTIAL`; other files still ship |
| Upstream returns a short page | write it as if complete | row-count vs expected fails → `state: "failed"` for that file; never present a truncated file as whole |
| A correction lands after the run | overwrite silently | a **new run id** (immutable; §4.4) with the corrected file; consumers see a new manifest and re-ingest (idempotent) |
| One of 350 files licensing-RED | mark the whole run `commercialOk:true` | that file `commercialOk:false`; the run is **only** as green as its reddest file (contamination rule) |

Why `PARTIAL`-with-honest-gaps beats fail-all: a market feed with 350 files should not lose 349 good files
because one provider hiccuped. The consumer gets the 349, sees the manifest says the 350th is
`unavailable` (so it knows *not* to treat the absence as zero), and re-requests later. **Absence recorded
is recoverable; a fabricated number is a silent, permanent lie.** This mirrors the warehouse-side rule in
`timescaledb-timeseries` (a missing bucket is missing data, not zero; gapfill is explicit and labeled) —
same principle, one layer up: the *file* channel must also never present absence as a value.

The manifest's `state` field (§5.2) is what makes this honest and machine-actionable: a consumer's loader
treats `unavailable`/`failed` files as "skip + alert + retry later," not "load 0 rows." And because the
whole run is idempotent (§5), the eventual successful re-run simply converges the warehouse — no double
load, no manual reconciliation.

---

## 10. The four invariants, as a checklist (the output contract for this layer)

A batch-channel design is **done** only when all four invariants are stated and enforced:

1. **It's a JOB, off the request path.** Create returns a **job id + `202`** immediately (§1.2); the
   extraction runs on the **Fly worker** triggered by external cron (scheduled) or the `POST` enqueue
   (on-demand) — **never** inline in a request handler (non-negotiable #4, #5). The job has an explicit
   **state machine** (`QUEUED→RUNNING→COMPLETE|FAILED`, +`PENDING_CANCEL`/`EXPIRED`, §3), queryable **by
   id**, with **two retention horizons** (files short, metadata longer, §3.4) implemented by object-store
   lifecycle + a metadata sweep, not an app timer.

2. **Delivery is atomic.** A half-written file is **never** visible: write-temp-then-rename
   (`os.replace`, §4.2) or S3 multipart-complete (object invisible until `CompleteMultipartUpload`, §4.3),
   ideally to an **immutable run-scoped path** with the manifest as the last atomic commit (§4.4, §6). A
   crashed worker leaves **no** partial a consumer can read.

3. **A manifest seals every run.** It lists each file with **row count + our-own checksum (not the S3
   ETag) + per-file `commercialOk` + attribution** (§5.2), written **last** as the run's `_SUCCESS`
   (§6). It is the consumer's contract: read through the manifest, never by directory enumeration.

4. **Everything is idempotent.** **Job-create** is idempotent by `Idempotency-Key` (on-demand) /
   `(definition, run_date)` (scheduled) so a double-fire never starts two extractions (§5.5).
   **Re-delivery** is idempotent by **content checksum** so re-downloading/re-notifying never
   double-loads the consumer's warehouse (§5.3) — **dedup by checksum, never by filename** (the Salesforce
   trap). The warehouse load is an **upsert by business key**, not a blind insert (§5.4). And
   **partial failure is honest**: provider-down → `unavailable` in the manifest + run `PARTIAL`, **never** a
   fabricated number (§9, non-negotiable #1).

If any one is missing, the feed is untrustworthy at scale: no manifest → consumers race a `RUNNING` job;
no atomicity → truncated files corrupt downstream numbers; no idempotency → cron double-fires
double-load; no partial-failure honesty → a provider hiccup either loses the whole feed or fabricates a
lie. The four together are what make a batch feed something a consumer's warehouse can load **blind and
nightly** without a human in the loop.

---

## References cited in this document

**Primary — provider File-Delivery / job APIs**
- JPMorgan `dataquery-sdk` (File Delivery API: `run_group_download`/`auto_download` SSE / `.sse_state`
  replay / `list_available_files` / `check_availability` / retry / rate-limit / pooling):
  <https://github.com/jpmorganchase/dataquery-sdk>
- LSEG Tick History — On-Demand Jobs and Files Management (job id, `/Jobs` endpoints, status states,
  cancel→`PendingCancellation`→`204`, 3-day file / 7-day job retention):
  <https://developers.lseg.com/en/article-catalog/article/tick-history-on-demand-jobs-and-files-management>
- LSEG Tick History — REST API Tutorials (scheduled vs on-demand distinction):
  <https://developers.lseg.com/en/api-catalog/refinitiv-tick-history/refinitiv-tick-history-rth-rest-api/tutorials>
- LSEG — How to Optimize Tick History file downloads (X-Direct-Download `302`→presigned S3, gzip,
  throughput numbers): <https://developers.lseg.com/en/article-catalog/article/how-optimize-tick-history-file-downloads-python-and-other-languages>
- Salesforce Data 360 — Bulk Ingestion (job state machine `Open/UploadComplete/InProgress/JobComplete/
  Failed/Aborted`, upsert-by-ExternalId, full-replace, **filename-tracking dedup trap**):
  <https://developer.salesforce.com/docs/data/data-cloud-int/references/data-cloud-ingestionapi-ref/c360-a-api-bulk-ingestion.html>

**Primary — atomicity, manifest, idempotency**
- AWS S3 — Multipart upload overview (in-progress uploads invisible; complete = atomic concatenate in
  part order; ETag = checksum-of-checksums ≠ MD5; conditional write; abort + lifecycle):
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html>
- Openbridge — Batch File Delivery Tips & Best Practices (the **manifest** with file state
  success/failure/pending; MD5 128-bit/32-char + XSHA256/512 checksums; `226`/`331` codes; redelivery;
  dot-prefixed/hidden-file naming rule):
  <https://docs.openbridge.com/en/articles/1453723-data-pipeline-batch-file-delivery-tips-and-best-practices>
- Cockroach Labs — Idempotency and ordering in event-driven systems (at-least-once delivery; dedup by
  unique/natural id; scoped ordering): <https://www.cockroachlabs.com/blog/idempotency-and-ordering-in-event-driven-systems/>
- Materialized View — *S3 Is the New SFTP* (atomic file exposure / no partial uploads; Iceberg-catalog
  central access; batch over websockets/polling): <https://materializedview.io/p/s3-is-the-new-sftp>

**Standards / scale**
- RFC 9110 §15.3.3 — `202 Accepted` (the async-job HTTP contract, status-monitor pointer):
  <https://www.rfc-editor.org/rfc/rfc9110#name-202-accepted>
- LSEG Data Feeds (market-data delivery scale; T+1 SFTP update products; 10 TB/day class):
  <https://www.lseg.com/en/data-analytics/market-data/data-feeds>

**Repo cross-references (this product line)**
- `python-fastapi-data-service` → `references/background-work-and-the-worker-boundary.md` — the law that
  the WRITE/extraction path is a separate worker, never a request-path background task (non-negotiable #4).
- `data-normalization-tet` — owns the TRANSFORM step inside `RUNNING` (raw upstream → canonical schema).
- `timescaledb-timeseries` — the warehouse the consumer loads into; its `INSERT … ON CONFLICT` is the
  upsert-by-business-key analog (§5.4) and its "missing bucket ≠ zero" rule is the §9 partner one layer
  down.
- Repo non-negotiables (`CLAUDE.md`): **#1** never invent a finance number (§9); **#2** `commercialOk`
  gate default-false (§5.2); **#4** no sockets/timers on the request path — heavy work on the worker
  (§1.2, §2.2, §8.3); **#5** persist/seal before response close.
