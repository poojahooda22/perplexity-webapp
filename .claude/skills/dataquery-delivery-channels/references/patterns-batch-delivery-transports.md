# patterns-batch-delivery-transports.md — the transport half of the batch channel

> **Product line.** This file belongs to the **`dataquery-delivery-channels`** dev-skill for the
> **JPM-Markets re-engineering data-analytics product line (NOT Lumina).** It is a **concrete build
> recipe**, not generic theory. It assumes the *content* of a batch delivery (which datasets, which
> columns, what format — CSV/Parquet/JSON) is already decided elsewhere (`patterns-batch-file-formats.md`
> / `theory-batch-channel-model.md`). This doc answers the **other half**: once you have produced a file,
> **how do you physically hand it to a consumer, securely, automatically, and with a "your file is ready"
> signal?**
>
> **Greenfield.** This product line has no committed code yet, so the recipe is design + runnable code,
> not `file:line` traces. The repo-mapping section at the end pins the *intended* infra: **Cloudflare R2**
> for object storage, **a Fly worker** for the batch generator + SFTP poller, and **presigned R2 URLs** as
> the modern default transport.

---

## 0. The shape of the problem (read this first)

A **batch delivery** is: *the producer writes a file, the consumer takes it.* There are exactly four
transports a real financial-data platform offers, and the incumbent we are re-engineering
(JPMorgan **DataQuery Batch**) offers two of them by name:

> "DataQuery Batch allows you to automate the delivery of your data by creating custom datasets,
> configuring reports, and automating the distribution of your data via **SFTP and email**."
> — [jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery)

The four transports, ranked by how a modern build should default:

| # | Transport | One-line identity | Default for |
|---|---|---|---|
| 1 | **S3 / R2 presigned URL** | a time-limited, IAM-scoped HTTPS GET link to one object | **cloud-native consumers — the modern default** |
| 2 | **SFTP** | a long-lived server endpoint; consumer's client pulls/pushes files into a per-partner directory | **enterprise/legacy consumers who mandate it** |
| 3 | **Secure-link / HTTPS download endpoint** | a `GET /downloads/{id}` route behind OAuth that *streams* or *302-redirects to* the object | consumers who want a stable, auth-gated URL inside your API |
| 4 | **Email** | an SMTP message | **notification + tiny files ONLY — never the bulk payload** |

Plus one cross-cutting concern that ties them together:

| 5 | **Notification fan-out** | the "your file is ready" event: webhook (server→server) or SSE (server→browser) |

This recipe builds all five. The **load-bearing rules** (stated once, enforced throughout):

1. **The bulk payload travels over an object transport (1, 2, or 3), never over email (4).** Email carries
   a *link* or a *notification*, never the 200 MB Parquet file.
2. **Every link is time-limited, least-privilege, and HTTPS-only.** A presigned URL is a **bearer token** —
   anyone who holds it can use it until it expires.
3. **SFTP has no native "file ready" event.** The consumer either *polls* their landing directory or you
   send an *out-of-band* notification (4 or 5). This is the single most-missed fact in the SFTP recipe.
4. **No public buckets, ever.** Access is always through a signed, expiring credential or an
   authenticated SFTP/HTTPS session.

---

## 1. Transport 1 — S3 / Cloudflare R2 presigned URL (the modern default)

### 1.1 What it is and why it is the default

A **presigned URL** is a URL you generate server-side that grants **temporary, scoped** access to **one
object** in your bucket — without making the bucket public and without giving the consumer any AWS/R2
credentials.

> "A presigned URL is a URL that you generate to provide temporary access to an object in your S3 bucket.
> It's a secure way to upload or download files without requiring AWS security credentials."
> — [docs.aws.amazon.com/AmazonS3/.../using-presigned-url.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)

The signature is computed from your credentials, the bucket, the key, the HTTP method, and the expiry — so
the URL **cannot be tampered with**:

> "The signature parameters cannot be tampered with, and attempting to modify the resource, operation, or
> expiry will result in a 403/SignatureDoesNotMatch error."
> — [developers.cloudflare.com/r2/api/s3/presigned-urls](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

**Why this is the modern default ("S3 is the new SFTP"):** the consumer needs only an HTTPS client (curl,
a browser, `requests`). No SSH daemon, no key exchange ceremony, no always-on server, no firewall
allow-listing of an SFTP host. AWS itself frames presigned URLs as the cloud-native alternative to
traditional file transfer:

> "Solutions to get files from a client into S3 can be grouped into two categories — the cloud native way
> where the client sends the file directly to S3, which represents a modern alternative to traditional SFTP."
> — [aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/)

And it is what the most demanding financial-data vendors do at petabyte scale. **LSEG (Refinitiv) Tick
History** added an "S3 direct" download path precisely because routing the file through their own LAN was
the bottleneck — a `302` redirect to a **presigned AWS URL** measured **66–118% faster in North America and
600–3000% faster in Europe** (see §1.6). When LSEG wants speed, they reach for a presigned S3 URL. So do we.

### 1.2 Hard limits you must design around

| Property | S3 value | R2 value | Source |
|---|---|---|---|
| **Max expiry (SDK)** | 7 days (604,800 s) | 7 days (604,800 s) | [AWS presigned-url docs](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/overview.html) · [R2 docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| **Min expiry** | 1 minute (console) / seconds (SDK) | 1 second | same |
| **Max expiry (console)** | 12 hours | n/a | [AWS docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) |
| **Single GET object size** | up to 5 TB stored; **5 GB practical per single-op share** | same S3 semantics | [AWS security blog](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/) |
| **Resumable / range from middle** | **No** — a dropped connection restarts from byte 0 | same | [builtin.com presigned-url guide](https://builtin.com/articles/presigned-url-s3-api-gateway-upload-file) |
| **Revocable mid-life?** | **No** — only expiry (or revoking the signer's IAM credential) ends it | same | [AWS security blog](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/) |
| **Custom-domain support (R2)** | n/a | **No** — presigned URLs work only on the S3-API domain | [R2 docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| **POST form upload (R2)** | supported on S3 | **Not supported** (GET/HEAD/PUT/DELETE only) | [R2 docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |

Two of these are **architecture-shaping**, not footnotes:

- **No resume / no range.** "S3 cannot start an object download from the middle of the object when using a
  pre-signed URL. If the recipient's connection is disrupted partway through a large download, they will
  restart from the beginning." ([builtin.com](https://builtin.com/articles/presigned-url-s3-api-gateway-upload-file)).
  → For **multi-GB** deliveries, **split the file into parts** (`part-0001.parquet`, `part-0002.parquet`,
  …) plus a manifest, and presign each part. A 200 MB Parquet/CSV chunk that fails re-downloads in seconds;
  a 50 GB monolith that fails at 99% is a disaster. (AWS: "To share a file larger than 5 GB, you must split
  the file into multiple parts." — [security blog](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/).)
- **Not revocable.** Once issued, the only kill switches are *expiry* and *revoking the signing credential*
  (which nukes every URL that credential signed). → Keep expiries **short**, and for a true revoke use the
  **secure-link transport (§3)** where you control a row in the DB, not a raw presigned URL.

### 1.3 Generating a presigned GET — runnable code (boto3, Python; the data-plane is Python)

This product line's data plane is **Python / FastAPI** (see the `python-fastapi-data-service` and
`timescaledb-timeseries` skills). So the canonical generator is **boto3**, pointed at **R2's S3-compatible
endpoint**.

```python
# delivery/transports/presigned.py
from __future__ import annotations

import os
import boto3
from botocore.config import Config
from dataclasses import dataclass

# R2's S3-compatible endpoint. Account-id form; presigned URLs do NOT work on a custom domain.
#   https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ENDPOINT = os.environ["R2_S3_ENDPOINT"]          # e.g. https://abc123.r2.cloudflarestorage.com
R2_BUCKET = os.environ["R2_DELIVERY_BUCKET"]        # one bucket; per-partner *prefixes*, never per-partner bucket
MAX_EXPIRY_S = 7 * 24 * 3600                         # 604_800 — the hard SDK ceiling

# region="auto" is R2's required value. addressing_style="virtual" matches S3 default;
# R2 also accepts path-style. signature_version s3v4 is mandatory for presigning.
_session = boto3.session.Session()
_s3 = _session.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    region_name="auto",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
)


@dataclass(frozen=True)
class PresignedDownload:
    url: str
    key: str
    expires_in_s: int


def presign_get(key: str, *, expires_in_s: int = 3600,
                download_filename: str | None = None) -> PresignedDownload:
    """Time-limited GET link to ONE object. `download_filename` forces the browser's
    save-as name via Content-Disposition (so `part-0001.parquet` doesn't save as the ugly key)."""
    if not 1 <= expires_in_s <= MAX_EXPIRY_S:
        raise ValueError(f"expires_in_s must be 1..{MAX_EXPIRY_S}, got {expires_in_s}")

    params: dict[str, str] = {"Bucket": R2_BUCKET, "Key": key}
    if download_filename:
        # Content-Disposition is signed into the URL — the consumer cannot change the served name.
        params["ResponseContentDisposition"] = f'attachment; filename="{download_filename}"'

    url = _s3.generate_presigned_url(
        ClientMethod="get_object",
        Params=params,
        ExpiresIn=expires_in_s,
    )
    return PresignedDownload(url=url, key=key, expires_in_s=expires_in_s)
```

The boto3 call signature is exactly what Cloudflare documents for R2:

```python
# From developers.cloudflare.com/r2/examples/aws/boto3/
get_url = s3.generate_presigned_url(
  'get_object',
  Params={'Bucket': 'my-bucket', 'Key': 'image.png'},
  ExpiresIn=3600
)
```
— [developers.cloudflare.com/r2/examples/aws/boto3](https://developers.cloudflare.com/r2/examples/aws/boto3/)

If a Node/TypeScript surface ever needs to presign (e.g. the Fly worker is JS), it is the AWS SDK v3
`getSignedUrl` against the identical R2 endpoint:

```typescript
// From developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const S3 = new S3Client({
  region: "auto",
  endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: "<ACCESS_KEY_ID>", secretAccessKey: "<SECRET_ACCESS_KEY>" },
});

const url = await getSignedUrl(
  S3,
  new GetObjectCommand({ Bucket: "my-bucket", Key: "deliveries/partner-x/2026-06-24/part-0001.parquet" }),
  { expiresIn: 3600 }, // seconds
);
```
— [developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)

### 1.4 Presigning a *multi-part* delivery + a manifest (the >5 GB recipe)

```python
# delivery/transports/presigned_batch.py
from delivery.transports.presigned import presign_get, PresignedDownload

def presign_delivery(part_keys: list[str], *, expires_in_s: int = 3600) -> dict:
    """Presign every part of a split delivery and return a manifest the consumer drives off.
    Each part is its own object => its own resumable unit; a dropped part re-fetches in seconds."""
    parts: list[PresignedDownload] = [
        presign_get(k, expires_in_s=expires_in_s, download_filename=k.rsplit("/", 1)[-1])
        for k in part_keys
    ]
    return {
        "schema": "delivery-manifest/v1",
        "expires_in_s": expires_in_s,
        "part_count": len(parts),
        "parts": [{"key": p.key, "url": p.url} for p in parts],
        # The consumer fetches every `url`, concatenates by `key` order, validates the row count.
    }
```

This mirrors Adobe Experience Platform's batch pattern, where a **manifest `.json`** describes a multi-file
export: it carries `exportResults.sinkPath`, `exportResults.name`, `scheduledTime`, and the run id, and "it
includes a list of files comprising the export."
([experienceleague.adobe.com/.../destinations/api/connect-activate-batch-destinations](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/api/connect-activate-batch-destinations)).
A consumer that gets the manifest first knows **exactly how many parts to expect** — so a missing part is
detectable, not silent corruption.

### 1.5 Security — the presigned-URL hardening checklist

Treat the URL as a **bearer token**. Cloudflare states it plainly: "Treat presigned URLs as bearer tokens.
Anyone with the URL can perform the specified operation until it expires."
([R2 docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)). The full hardening set, each with
a primary citation:

1. **Short expiry, sized to the job.** AWS's own guidance: downloads **5–15 min**, uploads **≤ 1 hour**;
   "the URL doesn't remain accessible longer than required since it can be reused while valid"
   ([AWS prescriptive guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/overview.html)).
   For a **batch download** that a partner's cron picks up, **1 hour** is a sane default; **24 h** is the
   absolute ceiling you should allow, and only on request. Never default to the 7-day max.

2. **Least-privilege signing credential.** "The capabilities of an S3 presigned URL are constrained by the
   permissions of the principal that created it."
   ([AWS Compute blog](https://aws.amazon.com/blogs/compute/securing-amazon-s3-presigned-urls-for-serverless-applications/)).
   So the R2 token / IAM role that *signs* download URLs must be scoped to **`s3:GetObject` on the delivery
   prefix only** — not the whole bucket, not `PutObject`. If that signer leaks, the blast radius is
   "someone can presign downloads of the delivery prefix," not "someone owns the bucket." Example AWS scope:
   grant `s3:GetObject` on `arn:aws:s3:::EXAMPLE-BUCKET/deliveries/*` and nothing else
   ([AWS Compute blog](https://aws.amazon.com/blogs/compute/securing-amazon-s3-presigned-urls-for-serverless-applications/)).
   In R2 terms: a **scoped API token** with read on the one bucket, object-read only.

3. **HTTPS only.** "Enforce HTTPS by generating and distributing URLs only over TLS and blocking HTTP at the
   edge." ([forwardnetworks.com](https://www.forwardnetworks.com/blog/2025/08/12/secure-aws-s3-access-with-pre%E2%80%91signed-url-automation/)).
   R2/S3 presigned URLs are HTTPS by construction; the rule is: **never log or email the raw URL over an
   insecure channel**, and never embed it in a page served over HTTP.

4. **Revocation reality.** "A pre-signed URL can be used by anyone who has access to the URL. Pre-signed URLs
   can be reused an unlimited number of times until they expire" — there is no mid-life revoke; "short
   expiration times can limit the potential for URL re-use."
   ([AWS security blog](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/)).
   Note also: "a presigned URL expires when the credential used to create it is revoked, deleted, or
   deactivated, even if created with a later expiration time"
   ([AWS prescriptive guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/overview.html))
   — so **rotating the signing token instantly invalidates every URL it signed** (the only batch-wide kill
   switch). If you need *per-link* revoke, use the **secure-link transport (§3)**, not a raw presigned URL.

5. **Don't put secrets in the key.** The key (path) is visible in the URL. Don't encode partner secrets,
   internal account ids, or PII into the object key. For *upload* presigns specifically, AWS recommends
   "sanitize the filename by replacing it with a generated UUID" to defend path-traversal
   ([AWS Compute blog](https://aws.amazon.com/blogs/compute/securing-amazon-s3-presigned-urls-for-serverless-applications/)).
   For *download* deliveries, prefer keys like `deliveries/{partner_uuid}/{run_uuid}/part-0001.parquet`.

6. **Restrict who can *generate* URLs.** "Restrict who can generate pre-signed URLs to minimize the risk of
   unauthorized access" ([forwardnetworks.com](https://www.forwardnetworks.com/blog/2025/08/12/secure-aws-s3-access-with-pre%E2%80%91signed-url-automation/)).
   Generation is an authenticated API call behind your own authz (the partner must be entitled to the
   dataset before you presign a download of it).

7. **(Uploads only) bind a Content-MD5 / Content-Type.** For the rarer case where a *consumer uploads to
   you* via a presigned PUT, sign in `Content-MD5` so "the upload operation succeeds only if both MD5
   digests match, ensuring end-to-end data integrity"
   ([AWS Compute blog](https://aws.amazon.com/blogs/compute/securing-amazon-s3-presigned-urls-for-serverless-applications/)),
   and pin `Content-Type` so a mismatched type fails with `403/SignatureDoesNotMatch`
   ([R2 docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)).

### 1.6 The LSEG proof — presigned S3 *is* what the fastest vendors ship

LSEG Tick History's "S3 direct" / "boost downloads with AWS" feature is a textbook re-implementation of this
transport, and the mechanism is worth internalizing because **we can copy it exactly** for our own
secure-link transport (§3):

- The consumer adds **`X-Direct-Download: true`** to their extraction request.
- LSEG responds **`302 Found`** with the object's **presigned AWS URL in the `Location` header**.
- That presigned URL is **self-authenticating**: "This is a self signed URI, using an AWS Access Key Id.
  This built-in authentication key avoids having to synchronize authentication details between AWS and
  DataScope servers."
  ([developers.lseg.com/.../boost-tick-history-downloads-with-aws](https://developers.lseg.com/en/article-catalog/article/boost-tick-history-downloads-with-aws)).
- **Why it's faster:** the non-direct path routes the bytes "through the Refinitiv LAN before and after
  accessing the AWS server"; the direct path "uses a shorter path" — measured **66–118% faster in NA,
  600–3000% in Europe** (transatlantic latency removed)
  ([developers.lseg.com](https://developers.lseg.com/en/article-catalog/article/boost-tick-history-downloads-with-aws)).
- **The gotcha to copy-proof against:** "Some HTTP clients fail because they include the original
  `Authorization` header in the redirect, causing AWS to reject dual authentication mechanisms"
  ([developers.lseg.com](https://developers.lseg.com/en/article-catalog/article/boost-tick-history-downloads-with-aws)).
  → On a `302`-to-presigned-URL design, the client must **drop its own `Authorization` header** when
  following the redirect (the presigned URL carries its own signature). Document this in our consumer SDK.

The product-level offer ("collect and download the data to your S3 bucket whenever you need it … petabyte
-scale … enterprise-grade security")
([lseg.com/.../tick-history/s3-direct](https://www.lseg.com/en/data-analytics/market-data/data-feeds/tick-history/s3-direct))
is exactly the shape of our batch channel. The takeaway: **presigned object URLs are not a toy — they are
the speed-optimized path the most demanding market-data vendor on earth chose.**

---

## 2. Transport 2 — SFTP (the enterprise/legacy mandate)

### 2.1 When you actually need it

You build SFTP **not** because it is better — it is older, statefully harder, and slower to wire — but
because a large enterprise consumer's **security policy mandates SFTP** and will not accept an HTTPS link.
This is real and common in financial services; JPMorgan offers it (`DataQuery` is "available via Web, Excel,
**SFTP**, email and API" — [jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery)).
So we offer it as a **second** transport, never the default.

**Do not hand-roll an `sshd`.** Use a **managed SFTP endpoint backed by object storage** so the file you
already wrote to R2/S3 *is* the file the SFTP user sees — one source of truth, no copy step. On AWS that is
**AWS Transfer Family**.

### 2.2 AWS Transfer Family — the managed-SFTP recipe

AWS Transfer Family "supports fully managed SFTP, FTPS, and FTP server endpoints to enable secure access to
customers' files stored in Amazon S3 and EFS"
([docs.aws.amazon.com/transfer](https://aws.amazon.com/aws-transfer-family/faqs/)). The mental model:

```
              ┌─────────────────────────────────────────────┐
 partner ──sftp──▶  AWS Transfer Family server (managed)     │
 (SSH key)    │      └── user: partner-x                     │
              │            home dir (logical) → /partner-x   │
              │            IAM role: scope-down to prefix    │
              │                       │                      │
              │                       ▼                      │
              │     S3 bucket  s3://deliveries/partner-x/    │  ← the SAME object you wrote
              └─────────────────────────────────────────────┘
                                      │ s3:ObjectCreated (on consumer UPLOAD)
                                      ▼
                            S3 Event Notification → EventBridge → Lambda (route + validate)
```

**Per-partner isolation (the load-bearing config):**

- Each user gets an **SSH public key** (you store it; Transfer Family accepts **RSA, ECDSA, and ED25519**,
  **up to 10 keys per user** — [AWS key-management docs](https://docs.aws.amazon.com/transfer/latest/userguide/key-management.html)).
- Each user gets an **IAM role** and a **home directory** that maps to an **S3 prefix**:
  "Each user gets a home directory that maps to an S3 prefix … you can use the same scope down policy for all
  your users to provide access to unique prefixes in your bucket based on their username"
  ([docs.aws.amazon.com/transfer/.../create-user.html](https://docs.aws.amazon.com/transfer/latest/userguide/create-user.html)).
- Use **logical directory mappings** so `partner-x` logs in and sees `/` = `s3://deliveries/partner-x/` and
  **cannot path-traverse** to another partner's prefix
  ([dzone AWS Transfer Family setup](https://dzone.com/articles/aws-transfer-family-sftp-setup-password-ssh-key-user)).

**The scope-down IAM policy** (every partner shares this template; `${transfer:UserName}` substitutes per
session — this is the SFTP analogue of "secure tool args by closure": the partner's identity is injected by
the platform, never supplied by the partner):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListOwnPrefix",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::deliveries",
      "Condition": { "StringLike": { "s3:prefix": ["${transfer:UserName}/*"] } }
    },
    {
      "Sid": "ReadOwnObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion"],
      "Resource": "arn:aws:s3:::deliveries/${transfer:UserName}/*"
    }
  ]
}
```

This is a **download-only** delivery (we write, partner reads). If a partner must *upload* to us (rarer —
e.g. they send us a universe file), add `s3:PutObject` on their prefix, and then the event-driven
validation pipeline (§2.4) earns its keep.

### 2.3 SFTP's missing event — the single most-missed fact

> **SFTP has no built-in "file ready" event.** The SFTP protocol gives you a file system, not a message bus.
> A consumer who pulls files from their landing directory has **no protocol-level signal** that today's file
> has arrived. They must **poll** the directory, or you must notify them **out-of-band**.

This is confirmed across sources: "SFTP uploads do not have a native file ready event mechanism … users must
either fire an S3 put notification event when a file is uploaded via SFTP, or alternatively switch to a cron
timer to check the bucket" ([search consensus, minio/AWS re:Post](https://repost.aws/questions/QUgbL671qZQ1KgR3rBwl7kGg/trigger-an-aws-lambda-function-with-an-ftp-sftp-event)).

So a correct SFTP delivery design **must pick one** of:

| Approach | How | When |
|---|---|---|
| **Consumer polls** | partner's cron lists their dir on a schedule, downloads new files | partner is fine polling; simplest; the classic legacy pattern |
| **Out-of-band notify (we push)** | after we write the file we send the partner a **webhook** or **email** "ready" signal (§4, §5) | partner wants near-real-time pickup; we own the notification |
| **Producer-side event (we react)** | the **S3 `ObjectCreated` event** on the backing bucket fires our Lambda/worker — but this fires on **OUR write or the partner's UPLOAD**, not on the partner's *download* | drives **our** post-write pipeline (validate, then notify), and (for upload deliveries) drives our ingest |

The critical nuance: **S3 events fire on object *creation*, which on a download delivery is *our* write**, not
the consumer's pickup. So "S3 event → Lambda" automates **our** side (validate the file, then fan out a ready
notification). It does **not** tell the partner anything — that still requires §4/§5. The one place S3 events
*do* tell us about consumer behavior is **uploads** (§2.4) and Transfer Family's own **EventBridge file-
transfer-completed events** (below).

**Transfer Family EventBridge events** close part of this gap on the *server* side: "AWS Transfer Family
publishes event notifications in Amazon EventBridge upon completion of a file transfer operation, and you can
use these events to automate post-upload processing"
([aws.amazon.com/.../transfer-family-publishes-events-eventbridge-servers](https://aws.amazon.com/about-aws/whats-new/2024/02/aws-transfer-family-publishes-events-eventbridge-servers/)).
These can even fire on a **download**: "execute automated actions when a user downloads a file such as
updating a tracking table or archiving the file"
([docs.aws.amazon.com/transfer/.../eventbridge.html](https://docs.aws.amazon.com/transfer/latest/userguide/eventbridge.html)).
**Caveat (cite it):** "Server-level events for SFTP, FTPS and FTP servers are delivered on a best effort
basis" ([same](https://docs.aws.amazon.com/transfer/latest/userguide/eventbridge.html)) — **best-effort, not
guaranteed**, so never make a correctness invariant depend on receiving the event; reconcile with a poll.

### 2.4 The event-driven validate-and-route pipeline (for UPLOAD deliveries)

When a partner **uploads** to their SFTP prefix (or when we write a file to be re-processed), the
`s3:ObjectCreated:*` event routes through EventBridge to a Lambda/worker that **validates and routes**:

```python
# delivery/sftp/on_object_created.py  (Lambda or Fly-worker consumer of the S3/EventBridge event)
import json

def handle(event: dict) -> dict:
    """Fires on s3:ObjectCreated. Validate the landed file, then route or reject.
    Idempotent: keyed by (bucket, key, etag) so a redelivered event is a no-op."""
    for rec in event["Records"]:
        bucket = rec["s3"]["bucket"]["name"]
        key = rec["s3"]["object"]["key"]            # e.g. partner-x/inbound/universe.csv
        etag = rec["s3"]["object"]["eTag"]
        partner = key.split("/", 1)[0]

        if already_processed(bucket, key, etag):     # idempotency guard (DynamoDB / Redis SETNX)
            continue

        ok, problems = validate_landed_file(bucket, key)  # schema, row count, encoding, checksum
        if not ok:
            quarantine(bucket, key)                  # move to partner-x/_rejected/, do NOT ingest
            notify_partner(partner, status="rejected", problems=problems)
        else:
            route_to_pipeline(bucket, key)           # hand to the normalization/ingest stage
            mark_processed(bucket, key, etag)
    return {"ok": True}
```

EventBridge can route the same event to **25+ targets** (Lambda, Step Functions, SQS, SNS) with filtering —
"you can now define granular triggers based on user identity or location"
([aws.amazon.com/.../transfer-family-publishes-events-eventbridge-servers](https://aws.amazon.com/about-aws/whats-new/2024/02/aws-transfer-family-publishes-events-eventbridge-servers/)).
For a busy endpoint, route to **SQS first** (durable buffer), then a worker drains it — so a burst of
uploads can't overrun the validator.

### 2.5 SFTP security — keys, host keys, least privilege

| Control | The rule | Source |
|---|---|---|
| **Key auth, not passwords** | SSH **public-key** auth (ED25519 preferred, then ECDSA, then RSA-3072+). No passwords on a data-delivery endpoint. | [AWS key-management docs](https://docs.aws.amazon.com/transfer/latest/userguide/key-management.html) |
| **Per-user key, ≤10 keys** | Each partner has their own key(s); Transfer Family stores up to 10 per user (enables zero-downtime rotation — add new, test, remove old). | [AWS key-management docs](https://docs.aws.amazon.com/transfer/latest/userguide/key-management.html) |
| **User-key rotation** | Rotate periodically: "limiting the lifespan of credentials and minimizing their exposure … minimize the risk of unauthorized access due to stolen, expired or outdated keys." | [jscape SFTP key rotation](https://www.jscape.com/glossary/sftp-key-rotation) |
| **Host-key rotation (server side)** | Rotate the *server's* host key on a schedule. NOTE: "this is a separate key used for validation, and host key rotation will have no impact on your SSH keys for login." Publish the new host-key fingerprint to partners ahead of the cutover or their clients will error on the changed fingerprint. | [files.com SSH host keys](https://www.files.com/blog/2025/02/07/sftp-ssh-host-keys-explained) · [AWS host-key docs](https://docs.aws.amazon.com/transfer/latest/userguide/configuring-servers-change-host-key.html) |
| **Pin the host key (consumer side)** | Consumers should `ssh-keyscan` and compare against a trusted fingerprint before connecting — "before initiating a connection, it's best practice to retrieve the expected host key … and compare it against a trusted source." | [stateofsecurity.com](https://stateofsecurity.com/how-to-rotate-your-ssh-keys/) |
| **Least-privilege per prefix** | The scope-down IAM role (§2.2) confines each user to their own prefix. A partner can never list or read another's directory. | [AWS create-user docs](https://docs.aws.amazon.com/transfer/latest/userguide/create-user.html) |
| **Compliance driver** | Credential lifecycle rotation is often *required*: "Regulatory requirements such as SOX, HIPAA or PCI DSS often call for credential lifecycle enforcement." | [jscape](https://www.jscape.com/glossary/sftp-key-rotation) |

### 2.6 The honest cost/complexity verdict on SFTP

AWS Transfer Family is a **billed, always-on managed server** (per-endpoint-hour + per-GB) — materially more
expensive and operationally heavier than presigned URLs, which charge "only for S3 storage, requests, and
data transfers" and where "if you create pre-signed URLs but the object isn't actually downloaded … you
don't pay transfer costs"
([AWS security blog](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/)).
The community verdict is blunt — newer S3-native file mounts are framed as making "Transfer Family SFTP
obsolete for most use cases"
([dev.to/aws-builders](https://dev.to/aws-builders/aws-s3-files-just-made-transfer-family-sftp-obsolete-for-most-use-cases-4me)).
**So:** offer SFTP only to consumers who contractually require it; default everyone else to presigned URLs.

---

## 3. Transport 3 — secure-link / HTTPS download endpoint behind OAuth

The middle ground between "raw presigned URL" (not revocable, no auth context) and "SFTP" (heavy, legacy):
a **stable `GET /v1/deliveries/{id}/download` route inside our own API**, gated by **OAuth2 bearer token**,
that — once it has checked entitlement — **`302`-redirects to a freshly-minted, short-lived presigned URL**.
This is **exactly the LSEG `X-Direct-Download` → `302` → presigned-URL pattern** (§1.6), re-implemented as our
own authenticated front door.

```python
# delivery/api/download_route.py  (FastAPI — the python-fastapi-data-service skill owns the app wiring)
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from delivery.transports.presigned import presign_get
from delivery.auth import require_scope          # OAuth2 bearer → principal + scopes
from delivery.repo import get_delivery           # row in our DB: {id, partner_id, object_key, status}

router = APIRouter(prefix="/v1/deliveries", tags=["delivery"])

@router.get("/{delivery_id}/download")
def download(delivery_id: str, principal=Depends(require_scope("deliveries:read"))):
    d = get_delivery(delivery_id)
    if d is None:
        raise HTTPException(404, "unknown delivery")
    if d.partner_id != principal.partner_id:      # authz: right user AND right row
        raise HTTPException(403, "not your delivery")
    if d.status == "revoked":                     # per-link revoke we control (presigned URLs can't)
        raise HTTPException(410, "delivery revoked")

    # Mint a *fresh* short-lived presigned URL on every call — the long-lived, revocable, auth-gated
    # handle is OUR route; the raw R2 URL is a 60-second implementation detail the partner never stores.
    link = presign_get(d.object_key, expires_in_s=60,
                       download_filename=d.object_key.rsplit("/", 1)[-1])
    record_download(delivery_id, principal)        # audit trail: who downloaded what, when
    return RedirectResponse(link.url, status_code=302)
```

**Why this is often the best of the three:**

- **Revocable & auditable.** We hold the row; flip `status="revoked"` and the link is dead *now* — the thing
  raw presigned URLs cannot do (§1.2).
- **Stable URL.** The partner bookmarks/automates one URL; the presigned secret rotates underneath every
  request (60-second expiry — the URL is in flight only as long as the redirect).
- **Real authz.** Bearer-token + entitlement check before any bytes; "you can implement custom security
  controls and business logic for specific access requirements through API Gateway authorizers"
  ([AWS security blog](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/)).
- **The LSEG-proven shape.** Same `302`-to-presigned mechanism the fastest market-data vendor ships (§1.6).
  Reuse their hard-won gotcha: tell consumers to **drop their `Authorization` header on the redirect hop**.

**Tradeoff:** for *very* large files, prefer redirecting to the presigned URL (bytes flow R2→partner
directly, our API never touches them) over **proxy-streaming** through our service (which puts every byte on
our compute and is a memory/timeout hazard — and on a serverless platform is forbidden by the same reasoning
that keeps sockets off Vercel). Our FastAPI service runs on **Fly** (persistent), so a *proxy* mode is
technically possible for small files, but **redirect-to-presigned is the default** — compute-once-serve-many,
bytes off the request path.

---

## 4. Transport 4 — email (notification + tiny files ONLY)

DataQuery Batch lists **email** as a delivery channel, and we match it — but with a hard rule:

> **Email carries a LINK or a NOTIFICATION, never the bulk payload.** Attachments are for tiny files
> (a < ~5 MB summary CSV, a reconciliation report). The 200 MB Parquet delivery is **always** a presigned
> link, never an attachment.

Why this is non-negotiable: mail servers cap attachment size (commonly ~10–25 MB), strip/quarantine large or
binary attachments, and there is no integrity check, no resume, and no audit on an email attachment. The AWS
security analysis is explicit that presigned URLs exist precisely to keep large transfers off such channels
([AWS security blog, Part 1](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/)).

**The correct email = "your batch is ready" + a link into the secure-link endpoint (§3):**

```python
# delivery/transports/email_notify.py
def send_ready_email(*, to: str, partner_name: str, delivery_id: str,
                     dataset: str, run_date: str, part_count: int) -> None:
    """Email the READY signal + a stable, auth-gated link. NEVER the file itself for bulk deliveries."""
    download_url = f"https://api.example.com/v1/deliveries/{delivery_id}/download"  # §3 route (OAuth-gated)
    subject = f"[Data Delivery] {dataset} — {run_date} ready ({part_count} part(s))"
    body = (
        f"Hello {partner_name},\n\n"
        f"Your batch delivery for {dataset} ({run_date}) is ready.\n"
        f"Download (sign-in required): {download_url}\n\n"
        f"This link is authenticated; the underlying file link expires after pickup.\n"
    )
    smtp_send(to=to, subject=subject, body=body)   # via SES/Resend/etc.; sign with DKIM/SPF/DMARC
```

Use email **also** as the out-of-band "file ready" signal for the **SFTP** transport (§2.3) — since SFTP has
no native event, an email/webhook is how the partner learns today's file landed.

**Email-channel hygiene:** authenticate the domain (SPF/DKIM/DMARC) so ready-emails aren't spam-filtered; the
link must be the **secure-link route**, never a raw presigned URL pasted into an email (emails get forwarded,
archived, and indexed — a raw bearer-token URL in an inbox is a leak waiting to happen).

---

## 5. Notification fan-out — the "file ready" event (webhook + SSE)

The cross-cutting layer that makes any transport *push* instead of *poll*. Two delivery shapes, by audience:

| Mechanism | Direction | Use it for | Don't use it for |
|---|---|---|---|
| **Webhook** | server → **server** | a partner's *backend* gets `POST /their-endpoint` "delivery ready", then pulls the file | a browser UI |
| **SSE** | server → **browser** | our own dashboard / a partner's web UI shows "delivery N ready" live | server-to-server (one server, lost-event risk) |

The tradeoff, sourced: "Webhooks are the right choice for event-driven server-to-server notifications, while
SSE is a great way to keep clients up-to-date … for many dashboards and feeds, SSE is simpler, more scalable,
and easier to debug" ([svix.com](https://www.svix.com/resources/faq/webhooks-vs-server-sent-events/)). And the
scaling caveat for SSE: "if the SSE stream fails for any reason, you could end up losing events, and it can
take up to a minute to detect this"
([particle.io webhooks-vs-sse](https://docs.particle.io/integrations/webhooks-vs-sse/)) — which is exactly why
the **durable** notification to a partner is a **webhook**, and SSE is reserved for the *live UI* that can
re-fetch on reconnect.

### 5.1 The webhook recipe (server→server delivery-ready), done right

A webhook is the durable "your file is ready" push to a partner's backend. The four production requirements,
each cited:

1. **HMAC signature (so the partner can verify it's us).** "Follow the HMAC definition in RFC 2104 and
   compare digests in constant time to avoid timing leaks"
   ([dev.to webhook delivery](https://dev.to/young_gao/building-reliable-webhook-delivery-retries-signatures-and-failure-handling-40ff)).
2. **At-least-once + idempotency key.** "Always design the receiving end to be idempotent … use delivery
   IDs/hashes, upserts, and reconciliation jobs"
   ([medium fan-out/DLQ/idempotency](https://medium.com/@bhagyarana80/scaling-webhooks-fan-out-dlqs-idempotency-ebe412ae55d1)).
3. **Retry with exponential backoff + jitter + a DLQ.** "Use exponential backoff + jitter for retries and a
   dead-letter queue (DLQ) for exhausted attempts; replay safely after fixes"
   ([same](https://medium.com/@bhagyarana80/scaling-webhooks-fan-out-dlqs-idempotency-ebe412ae55d1)).
   Distinguish retriable (timeouts, 503) from permanent (400) failures
   ([dev.to](https://dev.to/young_gao/building-reliable-webhook-delivery-retries-signatures-and-failure-handling-40ff)).
4. **Off the request path.** Sending happens from a **worker draining a queue**, never inline in the route
   that finished the file — "never do heavy work in the receiver" applies symmetrically to the sender.

```python
# delivery/notify/webhook.py
import hmac, hashlib, json, time

def sign_payload(secret: str, body: bytes, ts: int) -> str:
    """Standard-Webhooks-style signature: HMAC-SHA256 over `{ts}.{body}`; partner verifies in constant time."""
    msg = f"{ts}.".encode() + body
    return "v1=" + hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()

def build_ready_event(delivery_id: str, partner_id: str, object_key: str) -> dict:
    return {
        "id": f"evt_{delivery_id}",              # idempotency key — partner dedupes on this
        "type": "delivery.ready",
        "delivery_id": delivery_id,
        "partner_id": partner_id,
        "download_url": f"https://api.example.com/v1/deliveries/{delivery_id}/download",  # §3 route
        "created_at": int(time.time()),
    }

# enqueue_webhook(partner.webhook_url, build_ready_event(...))  →  worker delivers with backoff+DLQ
```

The worker delivers with **exponential backoff + jitter**, marks the attempt, and on exhaustion drops the
event into a **DLQ** for replay. The partner's receiver: verify signature → enqueue → return `2xx` fast →
pull the file asynchronously (return "2xx only after persisting to a queue … never do heavy work in the
receiver" — [dev.to](https://dev.to/young_gao/building-reliable-webhook-delivery-retries-signatures-and-failure-handling-40ff)).

### 5.2 SSE for our own dashboard (server→browser, live "ready" badge)

For the *operator/partner web UI*, SSE pushes "delivery N ready" without polling. One server, simple stream,
client auto-reconnects (`EventSource` retries on its own); on reconnect the UI re-fetches the delivery list
to cover any event missed during the gap (covering the "SSE can lose events" caveat above). This is the
*display* path; the *contractual* notification to a partner backend is always the **webhook** (§5.1).

### 5.3 Fan-out

One file-ready event often needs to reach several places: the partner's webhook, our own SSE dashboard, an
internal audit log, an SLA monitor. "Fan-out delivery lets a single event reach multiple destinations …
essential when different services need to react to the same … event"
([medium](https://medium.com/@bhagyarana80/scaling-webhooks-fan-out-dlqs-idempotency-ebe412ae55d1)). Implement
fan-out by publishing the one `delivery.ready` event to a topic/queue (SNS/SQS, or Redis Stream on our infra)
and letting each consumer (webhook-sender, SSE-pusher, auditor) subscribe independently — so a slow partner
webhook never blocks the SSE badge or the audit write.

---

## 6. The recommendation matrix — choosing per consumer

Pick the transport from **who the consumer is**, not from a default preference:

| Consumer profile | Default transport | Notification | Why |
|---|---|---|---|
| **Cloud-native** (has AWS/GCP/Azure, scripts curl/SDK) | **Presigned R2 URL (§1)** or **secure-link (§3)** | webhook | zero infra for them; fastest; cheapest; the LSEG-proven path |
| **Enterprise with an SFTP mandate** | **SFTP via Transfer Family (§2)** | email or webhook (SFTP has no native event) | their security policy requires it; managed endpoint = one source of truth |
| **Internal app / partner web UI** | **secure-link (§3)** | SSE (live badge) + webhook | stable auth-gated URL, revocable, audited |
| **Tiny report / human recipient** | **email with link (§4)** | the email *is* the notification | < 5 MB or just a "ready" signal; never the bulk file |
| **Wants near-real-time pickup** | presigned/secure-link + **webhook (§5)** | webhook (durable) + SSE (if UI) | push beats poll; webhook is the durable server→server signal |

**The default recommendation for a new consumer with no constraint: presigned R2 URL (§1) fronted by the
secure-link route (§3), with a webhook ready-notification (§5).** SFTP only on contractual demand; email only
for notifications and tiny files.

---

## 7. Repo mapping — how these transports land on OUR infra

This product line's data plane is **Python/FastAPI on Fly** + **Cloudflare R2** for object storage (see the
`python-fastapi-data-service` and `timescaledb-timeseries` skills). The transports map as:

| Transport | Our infra | Notes |
|---|---|---|
| **Presigned URL (§1)** | **R2** via boto3 / aws-sdk-v3 against `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | R2 is S3-API-compatible; presigning is **client-side, no R2 round-trip** ([R2 docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)). Account-id endpoint — **not** a custom domain. |
| **SFTP (§2)** | **out of scope for a pure-R2/Fly stack** — R2 has no managed-SFTP front door equivalent to AWS Transfer Family. Offer SFTP **only** if a partner mandates it, via an AWS Transfer Family endpoint over an S3 mirror, or a self-hosted `sftpgo`/`sshd` on a **Fly worker** writing to R2. State the cost. | Don't build SFTP speculatively; it is the heaviest, costliest, legacy-only transport. |
| **Secure-link (§3)** | a **FastAPI route on Fly** that authz-checks then `302`s to a fresh 60-s presigned R2 URL | the recommended default front door; revocable + audited (the LSEG `302` pattern). |
| **Email (§4)** | SES/Resend from the **Fly worker**; link points at the §3 route | notifications + tiny files only. |
| **Notification (§5)** | **webhook** sent from the **Fly worker** (queue-drained, backoff+DLFQ); **SSE** from the FastAPI app for the dashboard | the batch generator + SFTP poller + webhook sender all live in the **worker**, off the request path. |

**The batch generator and any SFTP-directory poll live in the Fly worker**, never in a request handler — same
discipline as Lumina's "Vercel can't hold sockets/timers → worker" rule, here because the FastAPI app must
stay request-fast while the heavy file-build/transfer runs off-path.

---

## 8. Anti-patterns (mistake → fix)

| Anti-pattern | Fix |
|---|---|
| Emailing the 200 MB Parquet as an attachment. | Email a **link** (§3/§4); the bulk payload travels over an object transport. Mail servers cap/strip large attachments; no resume, no integrity, no audit. |
| Making the delivery bucket **public** "so partners can download." | **Never.** Use a presigned URL (time-limited, scoped) or an authenticated SFTP/HTTPS session. A public bucket is an unscoped, never-expiring, un-audited leak. |
| Defaulting presigned URLs to the **7-day max** expiry. | Size expiry to the job: **5–15 min downloads, ≤1 h uploads** ([AWS guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/overview.html)); 1 h is a sane batch default, 24 h the ceiling. A long-lived bearer-token URL in a log/inbox is a breach. |
| Signing presigned URLs with a **full-bucket / admin** credential. | Scope the signer to `GetObject` on the **delivery prefix only** — "the capabilities of a presigned URL are constrained by the permissions of the principal that created it" ([AWS Compute blog](https://aws.amazon.com/blogs/compute/securing-amazon-s3-presigned-urls-for-serverless-applications/)). |
| Assuming SFTP has a **"file ready" event**. | It does **not** — the consumer **polls** or you **notify out-of-band** (email/webhook). S3 `ObjectCreated` fires on the *write/upload*, not the partner's *download*; Transfer Family EventBridge events are **best-effort**. |
| Proxy-**streaming** every byte of a large file through the API. | `302`-**redirect** to a presigned URL — bytes flow R2→partner directly (the LSEG pattern), keeping compute and memory off the request path. Proxy only tiny files, deliberately. |
| Webhook sender with **no retry / no idempotency key / no DLQ**. | At-least-once + idempotency id + exponential backoff & jitter + DLQ for replay ([medium](https://medium.com/@bhagyarana80/scaling-webhooks-fan-out-dlqs-idempotency-ebe412ae55d1)). HMAC-sign the payload, constant-time compare ([dev.to](https://dev.to/young_gao/building-reliable-webhook-delivery-retries-signatures-and-failure-handling-40ff)). |
| Pasting a **raw presigned URL** into an email/webhook body. | Send the **secure-link route** URL (§3) — auth-gated, revocable, audited. Raw presigned URLs get forwarded/archived/indexed; they are reusable bearer tokens until expiry. |
| Following a `302`-to-presigned redirect **with the original `Authorization` header** still attached. | **Drop** your own auth header on the redirect hop — the presigned URL self-authenticates; dual auth makes S3/R2 reject the request (the exact bug LSEG documents — [developers.lseg.com](https://developers.lseg.com/en/article-catalog/article/boost-tick-history-downloads-with-aws)). |
| One **bucket per partner**. | One bucket, **per-partner prefixes** + a scope-down IAM/token policy (`${transfer:UserName}/*`). Per-bucket-per-partner doesn't scale and complicates lifecycle/retention. |
| Reusing **one SSH key** across partners, or never rotating host/user keys. | Per-partner key (≤10 stored for zero-downtime rotation — [AWS key-management](https://docs.aws.amazon.com/transfer/latest/userguide/key-management.html)); rotate user keys on a schedule; publish new **host-key** fingerprints before the cutover ([files.com](https://www.files.com/blog/2025/02/07/sftp-ssh-host-keys-explained)). |
| Running the SFTP-directory poll or batch-file build **on the FastAPI request path**. | Move both to the **Fly worker** — heavy/scheduled work off the request path, same discipline as the serverless socket/timer rule. |

---

## 9. The R-SCALE tier statement (state it, every time)

| Tier | What this transport recipe survives | What breaks at the next tier |
|---|---|---|
| **1× (demo)** | A handful of partners; presigned URLs minted inline; one Fly worker builds + notifies; email notifications by hand. | Inline presign on the request path + synchronous webhook send blocks the API as partner count grows. |
| **100× (traction)** | Webhook sends **queue-drained** in the worker (backoff+DLQ); secure-link route presigns per request (60 s); per-partner prefixes + scope-down policy; SSE dashboard. | Per-partner *bucket* sprawl; un-batched multi-GB files; best-effort SFTP events trusted as guarantees; one signer credential's blast radius. |
| **10,000× (product)** | One delivery bucket, per-partner prefixes; **split multi-part** deliveries + manifest; fan-out via a topic (SNS/SQS/Redis Stream); webhook DLQ + replay; scoped-per-prefix signing tokens rotated regularly; SFTP only for the few who mandate it, on a managed endpoint with reconciliation polls (events are best-effort). | A measured ceiling on presign throughput or worker fan-out — at which point you shard the signer fleet / move fan-out to a dedicated event bus. Name the number before you cross it. |

**The failure this prevents:** shipping a Tier-1 transport (public bucket, 7-day URLs, inline synchronous
webhook, email attachments, "SFTP will notify them") while believing it is production-grade. Every one of
those is a security or scale incident waiting for real partner load.

---

## Sources (primary, read this run)

- **S3/presigned-URL** — [AWS S3 using-presigned-url docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) · [AWS Prescriptive Guidance: presigned-url overview](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/overview.html) · [AWS Security blog: securely transfer files with presigned URLs](https://aws.amazon.com/blogs/security/how-to-securely-transfer-files-with-presigned-urls/) · [AWS Compute blog: securing S3 presigned URLs for serverless](https://aws.amazon.com/blogs/compute/securing-amazon-s3-presigned-urls-for-serverless-applications/) · [forwardnetworks.com presigned-URL automation](https://www.forwardnetworks.com/blog/2025/08/12/secure-aws-s3-access-with-pre%E2%80%91signed-url-automation/) · [builtin.com presigned-URL S3 API Gateway](https://builtin.com/articles/presigned-url-s3-api-gateway-upload-file)
- **Cloudflare R2** — [R2 presigned-URLs docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) · [R2 aws-sdk-js-v3 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/) · [R2 boto3 example](https://developers.cloudflare.com/r2/examples/aws/boto3/)
- **AWS Transfer Family / SFTP** — [Transfer Family FAQs](https://aws.amazon.com/aws-transfer-family/faqs/) · [create-user / home-dir mapping](https://docs.aws.amazon.com/transfer/latest/userguide/create-user.html) · [key-management (RSA/ECDSA/ED25519, 10 keys)](https://docs.aws.amazon.com/transfer/latest/userguide/key-management.html) · [host-key rotation](https://docs.aws.amazon.com/transfer/latest/userguide/configuring-servers-change-host-key.html) · [EventBridge events (best-effort)](https://docs.aws.amazon.com/transfer/latest/userguide/eventbridge.html) · [Transfer Family publishes EventBridge events](https://aws.amazon.com/about-aws/whats-new/2024/02/aws-transfer-family-publishes-events-eventbridge-servers/) · [dzone Transfer Family SFTP setup](https://dzone.com/articles/aws-transfer-family-sftp-setup-password-ssh-key-user) · [dev.to: S3 Files vs Transfer Family](https://dev.to/aws-builders/aws-s3-files-just-made-transfer-family-sftp-obsolete-for-most-use-cases-4me) · [AWS re:Post: trigger Lambda from SFTP event](https://repost.aws/questions/QUgbL671qZQ1KgR3rBwl7kGg/trigger-an-aws-lambda-function-with-an-ftp-sftp-event)
- **SFTP security / keys** — [jscape SFTP key rotation](https://www.jscape.com/glossary/sftp-key-rotation) · [files.com SSH host keys explained](https://www.files.com/blog/2025/02/07/sftp-ssh-host-keys-explained) · [stateofsecurity.com rotate SSH keys](https://stateofsecurity.com/how-to-rotate-your-ssh-keys/)
- **LSEG S3-direct** — [developers.lseg.com: boost Tick History downloads with AWS](https://developers.lseg.com/en/article-catalog/article/boost-tick-history-downloads-with-aws) · [lseg.com Tick History S3 Direct](https://www.lseg.com/en/data-analytics/market-data/data-feeds/tick-history/s3-direct)
- **JPM DataQuery Batch** — [jpmorgan.com/markets/dataquery](https://www.jpmorgan.com/markets/dataquery)
- **Adobe Experience Platform (manifest pattern)** — [batch destinations API + manifest](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/api/connect-activate-batch-destinations) · [SFTP destination](https://experienceleague.adobe.com/en/docs/experience-platform/destinations/catalog/cloud-storage/sftp)
- **Notification fan-out** — [svix webhooks vs SSE](https://www.svix.com/resources/faq/webhooks-vs-server-sent-events/) · [particle.io webhooks vs SSE](https://docs.particle.io/integrations/webhooks-vs-sse/) · [medium: scaling webhooks fan-out/DLQ/idempotency](https://medium.com/@bhagyarana80/scaling-webhooks-fan-out-dlqs-idempotency-ebe412ae55d1) · [dev.to: reliable webhook delivery (retries/signatures)](https://dev.to/young_gao/building-reliable-webhook-delivery-retries-signatures-and-failure-handling-40ff)
