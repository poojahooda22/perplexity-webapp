# Supabase Storage — Buckets, Signed URLs, Transforms, and Storage RLS

> Storing and serving files and images on Supabase Storage: choosing bucket visibility
> deliberately, uploading (including resumable / large files), generating public vs signed URLs,
> image transformations, modeling per-user folders, and authoring Row Level Security policies on
> `storage.objects` — accurate to supabase-js 2.x and Postgres 15/16.
>
> **Lumina note:** as of the current codebase, Lumina does **not** use Supabase Storage. File
> uploads (the Health lab-report path) flow as base64 multimodal parts directly to the LLM —
> they are never persisted. Supabase Storage is documented here as the **correct future path** if
> uploaded reports (or user avatars, or generated PDFs) ever need to be persisted and re-served.
> See §Lumina for a concrete migration blueprint.

---

## Table of Contents

1. [Mental Model: Objects Are Rows, Buckets Are Tables](#1-mental-model-objects-are-rows-buckets-are-tables)
2. [Public vs Private Buckets: The Central Decision](#2-public-vs-private-buckets-the-central-decision)
3. [Creating Buckets via SQL Migration](#3-creating-buckets-via-sql-migration)
4. [File Size and MIME-Type Restrictions](#4-file-size-and-mime-type-restrictions)
5. [Uploading Files](#5-uploading-files)
6. [Content-Type, Cache-Control, and Upload Options](#6-content-type-cache-control-and-upload-options)
7. [Update, Move, Copy, and Remove](#7-update-move-copy-and-remove)
8. [Resumable Uploads for Large Files (TUS)](#8-resumable-uploads-for-large-files-tus)
9. [getPublicUrl vs createSignedUrl vs createSignedUploadUrl](#9-getpublicurl-vs-createsignedurl-vs-createsigneduploadurl)
10. [Downloading and Listing Objects](#10-downloading-and-listing-objects)
11. [Modeling Per-User Folders with auth.uid() as Path Prefix](#11-modeling-per-user-folders-with-authuid-as-path-prefix)
12. [Storage RLS: Policies on storage.objects](#12-storage-rls-policies-on-storageobjects)
13. [Image Transformations on Render](#13-image-transformations-on-render)
14. [Image Transformations on Upload (Optimize at Ingest)](#14-image-transformations-on-upload-optimize-at-ingest)
15. [Avoiding Hotlinking and Over-Exposure](#15-avoiding-hotlinking-and-over-exposure)
16. [Server-Side Uploads (Trusted Backend)](#16-server-side-uploads-trusted-backend)
17. [TanStack Query and React Integration](#17-tanstack-query-and-react-integration)
18. [Lumina: Current Path vs Storage Migration Blueprint](#18-lumina-current-path-vs-storage-migration-blueprint)
19. [Anti-Patterns](#19-anti-patterns)
20. [See Also](#20-see-also)

---

## 1. Mental Model: Objects Are Rows, Buckets Are Tables

Supabase Storage is not a separate auth universe. It is built **on top of Postgres**: two system
tables in the `storage` schema hold all the metadata, and the actual bytes live in object storage
(S3 on hosted Supabase, MinIO in the local CLI stack).

| Concept | Postgres backing | What it holds |
|---|---|---|
| Bucket | `storage.buckets` row | `id` (the bucket name), `public` flag, `file_size_limit`, `allowed_mime_types`, `owner` |
| Object | `storage.objects` row | `bucket_id`, `name` (full path including "folder" prefix), `owner`, `metadata` (size, mimetype, cacheControl), `path_tokens` |
| "Folder" | not a real entity | a path prefix — `reports/<uid>/2026-lab.pdf` has no folder row; folders are an illusion produced by `list()` |

Three consequences follow immediately:

1. **Authorization is RLS on `storage.objects`.** A request to read or write a file is authorized
   by evaluating policies against the candidate object row. You key those policies off `bucket_id`
   and helper functions like `storage.foldername(name)` (see §12).
2. **There are no real folders.** `reports/abc/file.pdf` is a single object whose `name` is the
   whole string. Deleting a "folder" means removing every object under the prefix.
3. **Paths are security-relevant.** Because policies inspect path segments, the path convention
   *is* your access-control schema. Putting `auth.uid()` as the first path segment is the
   canonical per-user isolation pattern (§11).

```
                   supabase-js storage client
                              │
      ┌───────────────────────┼────────────────────────┐
      ▼                       ▼                         ▼
getPublicUrl()          upload()/download()       createSignedUrl()
(no network, just       (Storage REST API,        (Storage REST API,
 string concat)          RLS-checked)              RLS-checked, returns
      │                       │                    a time-limited token)
      ▼                       ▼                         ▼
/storage/v1/object/    storage.objects (Postgres) ── RLS ──> allow/deny
  public/<bucket>/...          │
                               ▼
                        S3 / MinIO bytes
```

---

## 2. Public vs Private Buckets: The Central Decision

The single most consequential choice is **bucket visibility**, because it determines which URL
function works and whether RLS guards reads.

| Aspect | Public bucket (`public = true`) | Private bucket (`public = false`) |
|---|---|---|
| Read authorization | None — anyone with the URL can `GET` the object | RLS-evaluated on every read; needs a signed URL or authenticated download |
| URL function | `getPublicUrl()` — permanent, stable URL | `createSignedUrl()` — time-limited token |
| CDN cacheable | Yes (ideal for hot static assets) | Signed URLs cacheable but expire; per-user URLs fragment the cache |
| Upload/update/delete | Still RLS-gated (write policies always apply) | Still RLS-gated |
| Good for | Public marketing images, open avatars | User-uploaded PHI, generated PDFs, paid content |
| Risk if wrong | Leak: private docs become world-readable | Broken `<img>` if you called `getPublicUrl` on a private bucket |

**Critical clarification:** the `public` flag controls **read** access only. Even on a public
bucket, uploads, updates, and deletes are always governed by RLS. A public bucket is not a
write-open bucket. Calling `getPublicUrl()` on a private bucket produces a URL that returns a
400 — a classic silent bug producing broken images.

Decision table:

| Question | Answer |
|---|---|
| Could a leaked URL harm the user (PHI, PII, paid content)? | **Private** bucket + `createSignedUrl` |
| Is the asset truly public and shared by all (logo, open badge)? | **Public** bucket + `getPublicUrl` |
| Per-user asset that is acceptable to be world-readable if guessed? | **Public** with unguessable path + write RLS |
| Need per-request expiry or revocation? | **Private** + short-lived signed URLs |
| Asset embedded in many pages needing CDN hot path? | **Public** (signed URLs fragment the cache key) |

---

## 3. Creating Buckets via SQL Migration

Create buckets in a versioned migration so local / staging / prod stay in sync. Both a SQL
migration (preferred for reproducibility) and the JS admin API work.

```sql
-- supabase/migrations/20260601090000_storage_buckets.sql

-- Private bucket for user-uploaded lab reports (PHI-adjacent — never public).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lab-reports',
  'lab-reports',
  false,
  20 * 1024 * 1024,                              -- 20 MiB cap
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public            = excluded.public,
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Private bucket for system-generated PDF exports (filled by trusted backend).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'exports', 'exports', false,
  50 * 1024 * 1024,
  array['application/pdf']
)
on conflict (id) do nothing;

-- Public bucket for user-facing static assets (open badges, shared cover art).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'public-assets', 'public-assets', true,
  5 * 1024 * 1024,
  array['image/png', 'image/jpeg', 'image/webp', 'image/avif']
)
on conflict (id) do nothing;
```

The JS admin equivalent (run with the **service-role** key, never in the browser):

```ts
// scripts/create-buckets.ts — run with the service-role key.
import { createClient } from '@supabase/supabase-js';

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,   // server-only secret
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { data, error } = await admin.storage.createBucket('lab-reports', {
  public: false,
  fileSizeLimit: '20MB',
  allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
});
if (error) throw error;
```

`createBucket` is an admin operation. It requires the service-role key and is not something you
do from a logged-in user's browser session.

To inspect/update later: `admin.storage.getBucket('lab-reports')`,
`admin.storage.updateBucket('lab-reports', { fileSizeLimit: '30MB' })`,
`admin.storage.emptyBucket('lab-reports')`, `admin.storage.deleteBucket('lab-reports')`.

---

## 4. File Size and MIME-Type Restrictions

There are two layers of size enforcement, and you want both:

1. **Bucket-level** (`file_size_limit`, `allowed_mime_types`) — enforced by the Storage service
   on every upload, regardless of client. This is the real trust boundary.
2. **Project-level** global upload limit — a hosted-plan ceiling. The bucket limit can be lower
   than the global limit but not higher than the plan ceiling.

```sql
-- Tighten an existing bucket via migration.
update storage.buckets
set file_size_limit   = 20 * 1024 * 1024,      -- bytes
    allowed_mime_types = array['application/pdf','image/png','image/jpeg','image/webp']
where id = 'lab-reports';
```

When a file violates the bucket limit, the upload fails with an error in `{ data, error }` —
supabase-js does not throw. Always check it:

```ts
const { data, error } = await supabase.storage
  .from('lab-reports')
  .upload(path, file);

if (error) {
  // error.message includes the reason:
  // "The object exceeded the maximum allowed size"  (file_size_limit)
  // "mime type ... is not supported"                (allowed_mime_types)
  // "The resource already exists"                   (duplicate, upsert: false)
  showToast(error.message);
  return;
}
```

**Always set `allowed_mime_types`.** Without it, an attacker can upload an HTML or SVG file to a
public bucket and serve it from your domain (stored-XSS / phishing vector). Restrict image
buckets to raster types; explicitly exclude `image/svg+xml` from public buckets unless you
sanitize SVGs server-side (SVG can carry script).

Validate on the client too for UX (instant feedback), but never *only* on the client — the
bucket constraint is the trust boundary:

```ts
const MAX_BYTES = 20 * 1024 * 1024;
const OK_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

function validateUpload(file: File): string | null {
  if (!OK_TYPES.has(file.type)) return 'Only PDF, PNG, JPEG, or WebP files.';
  if (file.size > MAX_BYTES) return 'File must be 20 MB or smaller.';
  return null;
}
```

---

## 5. Uploading Files

`upload(path, fileBody, options)` is the workhorse. `fileBody` can be a `File`, `Blob`,
`ArrayBuffer`, `FormData`, `ReadableStream`, or `string`. The `path` is the full object name
including any folder prefix.

```ts
// frontend/src/lib/storage.ts (hypothetical — not yet in the repo)
import { supabase } from '@/lib/supabase';

async function uploadLabReport(userId: string, file: File): Promise<string> {
  const v = validateUpload(file);
  if (v) throw new Error(v);

  // Path: <uid>/<uuid>.<ext> — uid prefix is the RLS key; UUID avoids collisions.
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'pdf';
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;

  const { data, error } = await supabase.storage
    .from('lab-reports')
    .upload(path, file, {
      contentType: file.type,
      cacheControl: '3600',
      upsert: false,             // fail if exists (each report is a unique upload)
    });

  if (error) throw error;
  return data.path;
}
```

Key option semantics:

| Option | Default | Meaning |
|---|---|---|
| `upsert` | `false` | `false`: error if path already exists. `true`: overwrite in place. |
| `contentType` | inferred from filename/blob | The MIME type stored and returned on download. |
| `cacheControl` | `'3600'` | `Cache-Control: max-age=<n>` on the served object. |
| `duplex` | — | Required (`'half'`) when streaming a `ReadableStream` in Node/Bun. |
| `metadata` | — | Arbitrary user metadata (object). Retrievable via `info()` / `list()`. |

**Three strategies for user-replaceable files:**

- **Overwrite (`upsert: true`)** — same path, new bytes. CDN/browser may serve the stale copy;
  mitigate with a cache-busting query param (`?v=<timestamp>`) or short `cacheControl`.
- **New unguessable path each time** — upload a UUID-keyed path, store the pointer in your
  Prisma table, delete the old object. This is the cleanest caching story.
- **`update()`** — explicitly replaces bytes of an existing object; errors if it does not exist.

For user-replaceable files, the **new-path + pointer column + delete-old** approach is the most
robust because it sidesteps CDN cache staleness entirely:

```ts
async function replaceLabReport(userId: string, file: File): Promise<string> {
  const newPath = `${userId}/${crypto.randomUUID()}.${file.name.split('.').pop()}`;

  const up = await supabase.storage
    .from('lab-reports')
    .upload(newPath, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
  if (up.error) throw up.error;

  // Swap the pointer in Prisma, then delete the old object (best-effort).
  // (Assuming a hypothetical user_uploads table or profile.lab_report_path column.)
  const oldPath = await getOldReportPath(userId);            // your Prisma query
  await setReportPath(userId, newPath);                      // your Prisma update

  if (oldPath && oldPath !== newPath) {
    await supabase.storage.from('lab-reports').remove([oldPath]); // ignore failure
  }
  return newPath;
}
```

---

## 6. Content-Type, Cache-Control, and Upload Options

`Content-Type` governs how the browser treats a served object. Get it wrong and a PDF downloads
as `application/octet-stream`, or an image renders as text.

- **Always pass `contentType` explicitly** when you know it. Default inference from the filename
  extension breaks for `Blob`s with no name or `ArrayBuffer` bodies (which default to
  `text/plain;charset=utf-8`).
- For canvas/blob exports, set the type on the `Blob` and in options:

```ts
const blob: Blob = await new Promise((res) =>
  canvas.toBlob((b) => res(b!), 'image/webp', 0.9),
);
await supabase.storage.from('lab-reports').upload(path, blob, {
  contentType: 'image/webp',
  cacheControl: '31536000',
  upsert: false,
});
```

**Cache-Control strategy by path strategy:**

| Path strategy | `cacheControl` | Why |
|---|---|---|
| Immutable unguessable path (UUID in name) | `'31536000'` (1 year) | The bytes never change for that path — cache forever |
| Stable path you overwrite | `'0'` or short + cache-bust query | Bytes change under a fixed URL — don't let CDN serve stale |
| Public hot static asset | `'3600'`–`'86400'` | Balance freshness and cache hit rate |

To change `Content-Type` or `Cache-Control` of an existing object you must re-upload it
(`update()` or `upload({ upsert: true })`) — there is no metadata-only PATCH in supabase-js.

---

## 7. Update, Move, Copy, and Remove

```ts
const storage = supabase.storage.from('lab-reports');

// UPDATE — replace bytes of an EXISTING object (errors if missing).
const u = await storage.update(`${userId}/report.pdf`, newBlob, { contentType: 'application/pdf' });

// MOVE — rename/relocate within the SAME bucket (atomic metadata op, no re-upload).
const m = await storage.move(`${userId}/report.pdf`, `${userId}/archived/report.pdf`);

// COPY — duplicate within the bucket (server-side; no download/re-upload).
const c = await storage.copy(`${userId}/report.pdf`, `${userId}/report-backup.pdf`);

// REMOVE — delete one or many objects (array of full paths).
const r = await storage.remove([`${userId}/archived/report.pdf`]);

for (const res of [u, m, c, r]) {
  if (res.error) console.error('storage op failed:', res.error.message);
}
```

Notes:

- `move`/`copy` operate within a single bucket in supabase-js. To move across buckets, download +
  re-upload + remove.
- `remove([...])` takes an array of paths, returns the list of removed objects in `data`. Each
  path is RLS-checked against your DELETE policy.
- **Deleting a "folder"**: there is no folder delete. List the prefix recursively, collect every
  object path, then `remove(allPaths)`. The list API is non-recursive, so walk subprefixes
  manually:

```ts
async function removeFolder(bucket: string, prefix: string): Promise<number> {
  const sb = supabase.storage.from(bucket);
  const toDelete: string[] = [];

  async function walk(dir: string) {
    const { data, error } = await sb.list(dir, { limit: 1000 });
    if (error) throw error;
    for (const entry of data ?? []) {
      const full = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.id === null) await walk(full);   // "folder" entry — recurse
      else toDelete.push(full);
    }
  }
  await walk(prefix);

  for (let i = 0; i < toDelete.length; i += 1000) {
    const { error } = await sb.remove(toDelete.slice(i, i + 1000));
    if (error) throw error;
  }
  return toDelete.length;
}
```

- **Orphaned-bytes hazard**: deleting a `storage.objects` row directly via SQL does not delete
  the S3 bytes. Always delete through the Storage API so both the row and bytes are removed.
  If you store object paths in your own Prisma table, deleting the table row does not remove the
  file — clean up explicitly.

---

## 8. Resumable Uploads for Large Files (TUS)

Standard `upload()` is a single PUT, subject to the global upload size limit (tens of MB on
standard plans). For large files — high-resolution lab images, multi-page PDFs — use **resumable
uploads** via the [TUS protocol](https://tus.io/), which Supabase Storage implements. Resumable
uploads chunk the file, survive network drops, and resume from the last completed chunk.

**Using `tus-js-client`** (recommended for > 50 MB):

```ts
import * as tus from 'tus-js-client';
import { supabase } from '@/lib/supabase';

async function resumableUpload(bucket: string, path: string, file: File): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  return new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${token}`,   // user JWT → RLS applies
        'x-upsert': 'true',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,     // allow re-upload of same file later
      chunkSize: 6 * 1024 * 1024,          // MUST be exactly 6 MiB for Supabase TUS
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: file.type,
        cacheControl: '3600',
      },
      onError: reject,
      onProgress: (sent, total) => {
        const pct = ((sent / total) * 100).toFixed(1);
        console.log(`upload ${pct}%`);
      },
      onSuccess: () => resolve(),
    });

    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
      upload.start();
    });
  });
}
```

> **`chunkSize` must be exactly 6 MiB** (`6 * 1024 * 1024`) for Supabase's TUS implementation.
> Other values cause failures. The endpoint is `/storage/v1/upload/resumable`.

When to choose resumable:

| File size | Connection | Use |
|---|---|---|
| < ~6 MB | reliable | standard `upload()` |
| 6 MB – ~50 MB | reliable | standard `upload()` or resumable for progress UX |
| > 50 MB, or mobile / flaky connection | any | **resumable (TUS)** |

For signed upload URLs + resumable transfer (server-gated large uploads), see §9.

---

## 9. getPublicUrl vs createSignedUrl vs createSignedUploadUrl

Three URL functions, three jobs. Choosing wrong is the #1 storage bug.

| Function | Bucket | Network call? | Lifetime | Use for |
|---|---|---|---|---|
| `getPublicUrl(path)` | **public** | No (pure string build) | Permanent | `<img src>` on public assets |
| `createSignedUrl(path, expiresIn)` | **private** | Yes (REST, RLS-checked) | `expiresIn` seconds | Time-limited read of a private file |
| `createSignedUrls(paths, expiresIn)` | **private** | Yes | `expiresIn` seconds | Batch signed URLs for a gallery |
| `createSignedUploadUrl(path)` | any | Yes (RLS-checked) | ~2 hours (token) | Hand a one-time upload token to a client |

### getPublicUrl — public buckets only

```ts
// Synchronous; returns { data: { publicUrl } }. No error field — it just builds a URL.
const { data } = supabase.storage.from('public-assets').getPublicUrl('badge/lumina.webp');
// data.publicUrl → https://<ref>.supabase.co/storage/v1/object/public/public-assets/badge/lumina.webp
```

`getPublicUrl` does not check existence or permissions — it concatenates a URL. Pointing it at a
private bucket returns a URL that 400s. There is no `error` field; verify the bucket is `public`
yourself.

### createSignedUrl — private reads

```ts
async function signedReportUrl(userId: string, path: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from('lab-reports')
    .createSignedUrl(path, 15 * 60, {          // 15 minutes — PHI: keep short
      download: false,
    });
  if (error) throw error;
  return data.signedUrl;
}
```

The signed URL embeds a JWT carrying the path, expiry, and transform params. After `expiresIn`
it 400s. **The RLS check happens at sign time, not at fetch time** — once signed, anyone with the
URL can fetch it until expiry. Keep `expiresIn` short for sensitive content (minutes for PHI,
hours for images). For a **download prompt** (force "Save As" with a filename):

```ts
const { data } = await supabase.storage
  .from('exports')
  .createSignedUrl(`${userId}/summary.pdf`, 120, { download: 'lumina-export.pdf' });
// download: <string> sets Content-Disposition: attachment; filename="lumina-export.pdf"
```

Batch for galleries (one round trip):

```ts
const paths = items.map((i) => i.path);
const { data, error } = await supabase.storage
  .from('lab-reports')
  .createSignedUrls(paths, 600);
// data: Array<{ path, signedUrl, error }> — each entry may individually error
```

### createSignedUploadUrl — server-gated client uploads

When a trusted backend decides *whether and where* a client may upload — but the bytes stream
directly from the client to Storage (not through your backend) — issue a **signed upload URL**:

```ts
// On the Lumina backend (Express route, with req.userId validated):
const { data, error } = await admin.storage
  .from('lab-reports')
  .createSignedUploadUrl(`${req.userId}/${crypto.randomUUID()}.pdf`);
// data: { signedUrl, token, path }

// On the client: upload using the token (no Supabase service-role key on the client).
const { data: up, error: upErr } = await supabaseAnon.storage
  .from('lab-reports')
  .uploadToSignedUrl(data.path, data.token, file, { contentType: file.type });
```

The signed upload URL is single-use and short-lived (~2h). The backend enforces business rules
(does this user have quota? is the file type allowed?); the heavy bytes never transit the
Lumina backend. Combine with the per-user folder convention (§11) so the path is constrained.

---

## 10. Downloading and Listing Objects

### download — fetch bytes

```ts
const { data, error } = await supabase.storage
  .from('lab-reports')
  .download(`${userId}/report.pdf`);         // RLS-checked
if (error) throw error;
const blob: Blob = data;                      // type reflects stored content-type
const url = URL.createObjectURL(blob);
// ... open or render the blob
URL.revokeObjectURL(url);                     // cleanup when done
```

`download` returns a `Blob`. For **rendering an image**, prefer `createSignedUrl` for the
`<img src>` (lets the CDN cache, avoids holding the blob in JS memory). Use `download` when you
actually need the bytes (parse a PDF, hash a file, re-encode).

### list — enumerate a prefix

```ts
const { data, error } = await supabase.storage
  .from('lab-reports')
  .list(`${userId}`, {
    limit: 100,
    offset: 0,
    sortBy: { column: 'created_at', order: 'desc' },
    search: 'lab',             // filter by name substring
  });
// data: Array<FileObject> with { name, id, updated_at, created_at, metadata: { size, mimetype, ... } }
```

`list()` semantics that matter:

- It is **non-recursive**: immediate children of the prefix only. Subfolders appear as entries
  with `id === null` and `metadata === null`. Recurse manually (see §7's `walk`).
- It is **RLS-gated by your SELECT policy** — a user only sees objects they are allowed to read.
  This makes `list` a natural per-user file browser.
- `limit` defaults to 100 (max 1000 per call); paginate with `offset` or keyset on `name`.

---

## 11. Modeling Per-User Folders with auth.uid() as Path Prefix

The canonical isolation pattern: **make the first path segment the owner's user id.** Then a
single RLS expression — "the first folder equals my uid" — gates the entire bucket per user,
for every object, without a per-object owner column lookup.

```
lab-reports/
  3f9a...-uid-A/2026-blood-panel.pdf    ← only user A can read/write
  7c12...-uid-B/2026-allergy-test.pdf   ← only user B can read/write
exports/
  3f9a...-uid-A/summary.pdf
```

Client always builds paths with the authenticated uid as the prefix:

```ts
async function userPath(bucket: 'lab-reports' | 'exports', suffix: string): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  return `${user.id}/${suffix}`;
}

await supabase.storage.from('lab-reports')
  .upload(await userPath('lab-reports', `${crypto.randomUUID()}.pdf`), blob, { upsert: false });
```

The matching RLS predicate uses `storage.foldername(name)`, which splits the object path into an
array of segments. `storage.foldername(name)[1]` is the **first** segment (Postgres arrays are
1-indexed):

```sql
(storage.foldername(name))[1] = (select auth.uid())::text
```

This single predicate (used in §12) gives every user a private namespace. The path-prefix
approach also authorizes `list()` of a user's own folder cleanly and lets you reject an upload
to someone else's folder via `WITH CHECK` before inserting the row.

---

## 12. Storage RLS: Policies on storage.objects

Storage authorization = RLS policies on `storage.objects`. The same rules that apply to tables
apply here: `USING` governs which existing rows are visible or affected (SELECT/UPDATE/DELETE);
`WITH CHECK` governs which new or updated rows are allowed (INSERT/UPDATE). Wrap `auth.uid()` as
`(select auth.uid())` for planner caching.

RLS is enabled on `storage.objects` by default on Supabase. You add policies; you do not usually
toggle RLS itself.

### Per-user private bucket (lab-reports)

```sql
-- supabase/migrations/20260601090500_storage_policies.sql

-- READ: a user can read objects under their own uid folder in 'lab-reports'.
create policy "lab-reports: owner can read"
on storage.objects for select
to authenticated
using (
  bucket_id = 'lab-reports'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- INSERT: a user can upload only into their own folder.
create policy "lab-reports: owner can upload"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'lab-reports'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- UPDATE: must own both the existing row (USING) and the resulting row (WITH CHECK).
create policy "lab-reports: owner can update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'lab-reports'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'lab-reports'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- DELETE: a user can delete only within their own folder.
create policy "lab-reports: owner can delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'lab-reports'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
```

> **Forgetting `WITH CHECK` on INSERT/UPDATE is a real breach.** `USING` governs which existing
> rows you may read or affect. For INSERT you *must* use `WITH CHECK`. For UPDATE you typically
> need *both*: `USING` to select the row you may touch, `WITH CHECK` to constrain the new path.
> Omitting `WITH CHECK` either blocks all writes or fails to constrain the resulting path.

### Exports bucket — server writes only, per-user reads

System-generated exports (PDFs built by the Lumina backend with the service-role key) allow only
the owning user to read; no user INSERT policy means the browser cannot write:

```sql
-- Per-user read — the backend (service role) writes; users read their own.
create policy "exports: owner can read"
on storage.objects for select
to authenticated
using (
  bucket_id = 'exports'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
-- No INSERT policy for the authenticated role.
-- Service-role key bypasses RLS → backend can write freely.
```

### Public-read bucket with restricted writes

The bucket's `public = true` handles reads. Lock down who can upload:

```sql
-- Anyone can read via the public URL (bucket.public = true covers reads).
-- Only authenticated users who pass a custom check can write.
create policy "public-assets: admin can upload"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'public-assets'
  and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
);
```

### Role/claim-based policies

Read a custom JWT claim via `auth.jwt()`:

```sql
create policy "exports: admins can read all"
on storage.objects for select
to authenticated
using (
  bucket_id = 'exports'
  and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
);
```

### Performance for storage policies

The same scaling rules that apply to `storage.objects` (can hold millions of rows):

- Wrap `auth.uid()`/`auth.jwt()` as `(select ...)` so the planner evaluates once, not per row.
  This matters for `list()` and bulk `remove()` which scan many rows.
- Put `bucket_id = '...'` as the **first** predicate — it is indexed and cheap.
- Avoid expensive subqueries that re-run per object during `list()` of large prefixes.

### Testing storage policies locally

With the CLI stack (`supabase start`), test as a real user:

```ts
const a = createClient(URL, ANON);
await a.auth.signInWithPassword({ email: 'a@test.dev', password: 'pw' });

// Own folder → allowed.
const ok = await a.storage.from('lab-reports').upload(`${userA.id}/x.pdf`, blob);
expect(ok.error).toBeNull();

// Other user's folder → denied.
const bad = await a.storage.from('lab-reports').upload(`${userB.id}/x.pdf`, blob);
expect(bad.error).not.toBeNull();
```

---

## 13. Image Transformations on Render

Supabase Storage offers on-the-fly image transformation (resize, quality, format) at serve time.
Transformed renders are cached at the CDN so the first request transforms and subsequent requests
are cheap.

> Image transformations are a paid Storage feature on hosted Supabase (Pro plan+) and are
> configurable in the local CLI stack via the imgproxy service. The original object is never
> modified.

Public render with transform:

```ts
const { data } = supabase.storage.from('public-assets').getPublicUrl('badge/lumina.webp', {
  transform: {
    width: 256,
    height: 256,
    resize: 'cover',       // 'cover' | 'contain' | 'fill'
    quality: 75,           // 20–100
    format: 'origin',      // 'origin' keeps source format; omit to allow auto WebP/AVIF
  },
});
// → /storage/v1/render/image/public/public-assets/badge/lumina.webp?width=256&height=256&...
```

Note the path changes from `/object/public/...` to `/render/image/public/...`.

Transform option reference:

| Option | Values | Notes |
|---|---|---|
| `width` / `height` | px | At least one required to resize. Both + `resize` controls fit. |
| `resize` | `cover` (crop to fill), `contain` (fit inside), `fill` (stretch) | Default `cover` when both dims given. |
| `quality` | `20`–`100` (default ~80) | ~70–75 is a good web default. |
| `format` | `origin` | Forces the source format; omitting auto-negotiates WebP/AVIF via `Accept`. |

### Responsive images: srcSet from transforms

```tsx
function UserBadge({ path, alt }: { path: string; alt: string }) {
  const widths = [64, 128, 256];
  const url = (w: number) =>
    supabase.storage.from('public-assets').getPublicUrl(path, {
      transform: { width: w, quality: 75 },
    }).data.publicUrl;

  return (
    <img
      src={url(128)}
      srcSet={widths.map((w) => `${url(w)} ${w}w`).join(', ')}
      sizes="(max-width: 640px) 64px, 128px"
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  );
}
```

### Private transformed thumbnails

Sign + transform together so the thumbnail URL is both authorized and resized:

```ts
const { data, error } = await supabase.storage
  .from('lab-reports')
  .createSignedUrl(path, 3600, { transform: { width: 320, quality: 80 } });
```

Each distinct transform produces a distinct cache key. Per-user transformed thumbnails are less
CDN-friendly than public ones. For frequently shown small images, consider a public bucket with
unguessable paths so transformed thumbnails cache hot.

---

## 14. Image Transformations on Upload (Optimize at Ingest)

Render-time transforms recompute per distinct size and (on hosted plans) bill per transformation.
For assets where you control the canonical size, **optimize at ingest**: transform once, store the
optimized bytes, then serve the object directly.

**(a) Client-side downscale/encode before upload:**

```ts
async function downscaleToWebP(file: File, maxDim = 1024, quality = 0.82): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/webp', quality });
}

async function uploadOptimizedImage(userId: string, file: File): Promise<string> {
  const blob = await downscaleToWebP(file, 512, 0.85);
  const path = `${userId}/${crypto.randomUUID()}.webp`;
  const { error } = await supabase.storage
    .from('lab-reports')
    .upload(path, blob, { contentType: 'image/webp', cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return path;
}
```

**(b) Server-side optimization in a trusted backend** — accept the original, transform server-side
(with a library like `sharp` or by calling the render endpoint), store the optimized result. Use
this when you cannot trust the client to encode (mobile, public API) or want a canonical pipeline.

Decision: **render-time transforms** for galleries with many unpredictable sizes and unknown
clients; **upload-time optimization** for a small set of known sizes (thumbnails, avatars) where
you want the lowest serve cost and best cache behavior.

---

## 15. Avoiding Hotlinking and Over-Exposure

Public buckets are world-readable by design — but it cuts both ways.

1. **Unguessable paths.** Even on a public bucket, prefix object names with a UUID/hash so URLs
   cannot be enumerated. The `public` flag removes RLS on reads but does not require *guessable*
   names. This is "security through obscurity" only — never rely on it for truly sensitive data.

2. **Private + signed URLs for anything that must not leak.** PHI reports, generated exports,
   paid content → private bucket, short `expiresIn`. The signed URL is the only read path, and
   it expires.

3. **Short expiry + on-demand signing for sensitive content.** Sign a report URL for the viewing
   session (e.g., 15 minutes), and re-sign on demand. Do not hand out 24-hour signed URLs for
   PHI.

4. **Do not put PII in object paths.** Paths appear in logs, referrers, and CDN caches. Use the
   uid (an opaque UUID) as the prefix, not an email or name.

5. **Restrict MIME types on public buckets** (§4) so nobody serves `text/html` or
   `image/svg+xml` from your domain — both are XSS/phishing vectors on a public origin.

Quick reference:

| Content | Bucket | URL | Expiry |
|---|---|---|---|
| Public badge or logo | public | `getPublicUrl` | n/a |
| User lab report image | private | `createSignedUrl` | 15 min |
| System-generated export | private | `createSignedUrl(download)` | 5 min |
| Large upload (signed flow) | private | `createSignedUploadUrl` → `uploadToSignedUrl` | ~2h token |

---

## 16. Server-Side Uploads (Trusted Backend)

Two distinct trust models:

| Model | Who holds the key | RLS applies? | Use when |
|---|---|---|---|
| **Browser-direct (user JWT)** | client uses anon key + user session | **Yes** | Normal user uploads to their own folder |
| **Backend (service role)** | server holds service-role key | **No** | System-generated files, cross-user admin ops |

Use **browser-direct** by default — it scales, is correctly gated by storage RLS, and never
exposes the service-role key. Reach for the **service-role backend** model when:

- The file is generated server-side (a PDF export, a thumbnail derived from another file).
- Business rules do not fit cleanly in RLS predicates (quota checks, content scanning).
- The upload must touch other users' namespaces (admin operations).

**In Lumina's current Express backend** (not Supabase Edge Functions), the pattern is the same:
verify the caller via the auth middleware, then use an admin client to write:

```ts
// backend/connectors/exports/routes.ts (hypothetical example)
import { createClient } from '@supabase/supabase-js';
import { middleware } from '../../auth.js';
import type { AuthenticatedRequest } from '../../auth.js';

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,   // server-only secret
  { auth: { persistSession: false, autoRefreshToken: false } },
);

router.post('/export', middleware, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorised' });

  // 1. Generate the PDF bytes server-side (omitted).
  const pdfBytes: Uint8Array = await buildExportPdf(req.userId);
  const path = `${req.userId}/${crypto.randomUUID()}.pdf`;

  // 2. Write under the user's folder — service role bypasses RLS.
  const { error } = await admin.storage
    .from('exports')
    .upload(path, pdfBytes, { contentType: 'application/pdf', upsert: false });
  if (error) return res.status(500).json({ error: error.message });

  // 3. Return a short-lived signed URL so the user can fetch their export.
  const { data: signed } = await admin.storage
    .from('exports')
    .createSignedUrl(path, 5 * 60, { download: 'lumina-export.pdf' });

  return res.json({ url: signed?.signedUrl });
});
```

**Two non-negotiables visible here:**

- **Verify the caller's JWT before doing anything privileged.** In this pattern Lumina's `middleware`
  does that (see `backend/auth.ts`). The service-role client bypasses RLS, so Express is the
  only access-control boundary — if you skip auth, you build an open write relay into Storage.
- **The service-role key is server-only.** Never put it in a `VITE_*` env var or a React Native
  bundle. In the Lumina backend, env vars are read only in Express server code — this is already
  the correct boundary.

Note: Lumina's `backend/client.ts` creates a client used **only** for `auth.getUser()`, not for
Storage operations. If you add Storage to the backend, create a **separate** admin client (with
explicit `persistSession: false`) rather than reusing the auth client.

---

## 17. TanStack Query and React Integration

Wrap storage in small typed helpers and feed React via TanStack Query. Storage results are
`{ data, error }` — handle both; supabase-js does not throw.

```ts
// frontend/src/lib/storage.ts (hypothetical — not yet in the repo)
import { supabase } from './supabase';

export const BUCKETS = {
  labReports: 'lab-reports',
  exports: 'exports',
  publicAssets: 'public-assets',
} as const;
export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

export async function signedReportUrl(path: string, expiresIn = 900): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKETS.labReports)
    .createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function listUserReports(userId: string) {
  const { data, error } = await supabase.storage
    .from(BUCKETS.labReports)
    .list(userId, { sortBy: { column: 'created_at', order: 'desc' } });
  if (error) throw error;
  return data ?? [];
}
```

Query the signed URL with `staleTime` set below the expiry so TanStack Query re-fetches before
the URL expires:

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { signedReportUrl, listUserReports } from '@/lib/storage';

// Signed URL expires in 900s — set staleTime to 800s so we refetch before expiry.
function useReportUrl(path: string | null) {
  return useQuery({
    queryKey: ['report-url', path],
    enabled: !!path,
    queryFn: () => signedReportUrl(path!),
    staleTime: 800 * 1000,
    gcTime: 900 * 1000,
  });
}

function useUserReports(userId: string) {
  return useQuery({
    queryKey: ['user-reports', userId],
    queryFn: () => listUserReports(userId),
    staleTime: 30_000,
  });
}

function useUploadReport(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const v = validateUpload(file);
      if (v) throw new Error(v);
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'pdf';
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from('lab-reports')
        .upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
      if (error) throw error;
      return path;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-reports', userId] });
    },
  });
}
```

A simple upload component with validation and progress:

```tsx
function ReportUploader({ userId }: { userId: string }) {
  const upload = useUploadReport(userId);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const v = validateUpload(file);
    if (v) { setErr(v); return; }
    setErr(null);
    upload.mutate(file);
  }

  return (
    <label className="report-uploader">
      <input
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        onChange={onPick}
        disabled={upload.isPending}
      />
      {upload.isPending && <span>Uploading…</span>}
      {err && <span role="alert">{err}</span>}
      {upload.isError && <span role="alert">{(upload.error as Error).message}</span>}
    </label>
  );
}
```

---

## 18. Lumina: Current Path vs Storage Migration Blueprint

### Current architecture: multimodal pass-through (no persistence)

The Health tab's "Upload Report" feature (`health-workflows-and-upload.md` + `backend/index.ts`)
works as follows:

1. The user picks a PDF or image in the Health right-rail upload component.
2. `fileToAttachment` in the frontend converts the file to a base64 data URL.
3. The base64 string is sent in the `POST /perplexity_ask` body as an `attachments` field.
4. `buildAttachmentParts` in `backend/index.ts` (around line 533) constructs Vercel AI SDK
   `image` or `file` content parts from the base64 bytes.
5. Those parts are passed to `streamText` as the multimodal user message.
6. **The file is never written to disk or any database.** It exists only in the request body
   and in the in-flight model context.

This is correct for the current scope — per Health skill Non-Negotiable #4:
> Uploaded reports are user PHI-adjacent. The file flows as a base64 multimodal part to the
> model **for that request only** — there is no health-file store.

The current path also deliberately excludes health-upload answers from the semantic cache
(`cacheable = !isTimeSensitive(query) && parts.length === 0` — the `parts.length === 0` guard
in `backend/index.ts:534` ensures that).

### When Storage becomes the right path

Supabase Storage would be the correct upgrade if:

- Users need to **retrieve past uploads** (a "My Reports" history section).
- The report must be **reanalyzed** in a follow-up turn without re-uploading.
- Multiple users **share** an uploaded document (team workspace).
- Files are **large enough** that base64-in-body creates 25 MB+ request payloads (see
  `backend/index.ts:31`: `express.json({ limit: "25mb" })`).
- HIPAA compliance requires an **audit log** of who accessed which file and when.

### Migration blueprint (if Storage is added)

If you add Storage for lab reports, here is the correct sequence:

**Step 1 — Schema and bucket (SQL migration):**

```sql
-- supabase/migrations/20260700000000_lab_report_storage.sql

-- Bucket (private, PHI-adjacent).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lab-reports', 'lab-reports', false,
  20 * 1024 * 1024,
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
) on conflict (id) do nothing;

-- RLS: per-user folder, full CRUD on own.
create policy "lab-reports: owner read"  on storage.objects for select to authenticated
using (bucket_id = 'lab-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "lab-reports: owner write" on storage.objects for insert to authenticated
with check (bucket_id = 'lab-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "lab-reports: owner update" on storage.objects for update to authenticated
using  (bucket_id = 'lab-reports' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'lab-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "lab-reports: owner delete" on storage.objects for delete to authenticated
using (bucket_id = 'lab-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
```

**Step 2 — Prisma model to track pointers** (add to `backend/prisma/schema.prisma`):

```prisma
model LabReport {
  id           String   @id @default(uuid())
  userId       String   @map("user_id")
  storagePath  String   @map("storage_path")   // e.g. "<uid>/<uuid>.pdf"
  mimeType     String   @map("mime_type")
  sizeBytes    Int      @map("size_bytes")
  createdAt    DateTime @default(now()) @map("created_at")
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("lab_report")
}
```

**Step 3 — Backend upload endpoint:**

```ts
// backend/connectors/health/routes.ts (new file — requires full server restart; Bun --hot misses it)
import express from 'express';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import { middleware } from '../../auth.js';
import { prisma } from '../../db.js';
import type { AuthenticatedRequest } from '../../auth.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// POST /health/reports — upload a lab report.
router.post('/', middleware, upload.single('report'), async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorised' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file in request' });

  const allowed = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
  if (!allowed.has(file.mimetype)) return res.status(400).json({ error: 'Unsupported file type' });

  const ext = file.originalname.split('.').pop()?.toLowerCase() ?? 'pdf';
  const path = `${req.userId}/${crypto.randomUUID()}.${ext}`;

  const { error } = await admin.storage
    .from('lab-reports')
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) return res.status(500).json({ error: error.message });

  // Record the pointer in Prisma so users can list / re-retrieve past uploads.
  const report = await prisma.labReport.create({
    data: { userId: req.userId, storagePath: path, mimeType: file.mimetype, sizeBytes: file.size },
  });

  return res.json({ reportId: report.id, path });
});

// GET /health/reports/:id/url — generate a short-lived signed URL.
router.get('/:id/url', middleware, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorised' });

  // Ownership check via Prisma.
  const report = await prisma.labReport.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!report) return res.status(404).json({ error: 'Not found' });

  const { data, error } = await admin.storage
    .from('lab-reports')
    .createSignedUrl(report.storagePath, 15 * 60); // 15 min — PHI: keep short
  if (error) return res.status(500).json({ error: error.message });

  return res.json({ url: data.signedUrl });
});

export { router as healthReportsRouter };
```

**Step 4 — Cross-cutting checklist before shipping:**

- [ ] New files (`routes.ts`, `healthReportsRouter`) require a **full dev-server restart** — Bun
  `--hot` does not pick them up.
- [ ] Relative imports use **`.js` extensions** or Vercel's strict ESM resolver fails the build.
- [ ] The `SUPABASE_SERVICE_ROLE_KEY` is a **Vercel env var** only — never in `VITE_*`.
- [ ] The signed URL endpoint **re-checks ownership via Prisma** before signing — the admin client
  bypasses RLS so Express becomes the gate.
- [ ] Health upload answers are **excluded from the semantic cache** — the existing
  `parts.length === 0` guard in `backend/index.ts:534` handles this if you pass the report as a
  multimodal part for analysis; if you change the flow to a reportId reference, add an explicit
  `isHealthReport` flag to the cache guard.
- [ ] The `LabReport` model in `schema.prisma` uses **explicit `@map`** names and `@@map` to keep
  Prisma model names in PascalCase and SQL names in snake_case (per existing schema conventions).

---

## 19. Anti-Patterns

**Calling `getPublicUrl()` on a private bucket.** The returned URL hits `/object/public/...`,
which has no authorization and the object is not there — it 400s, producing silently broken
`<img>` tags. Fix: private buckets use `createSignedUrl()` (or `download()`); reserve
`getPublicUrl` for `public = true` buckets.

**Assuming a public bucket is write-open.** `public` controls reads only; uploads/updates/deletes
are always RLS-gated. Without write policies, all uploads to even a public bucket fail. Fix:
always author explicit INSERT/UPDATE/DELETE policies on `storage.objects`.

**Forgetting `WITH CHECK` on INSERT/UPDATE policies.** `USING` governs existing rows; it does
not authorize the *new* row's contents. An INSERT needs `WITH CHECK`; an UPDATE needs both.
Fix: INSERT → `WITH CHECK`; UPDATE → `USING` + `WITH CHECK`.

**Putting the service-role key in a client bundle.** The service-role key bypasses all RLS —
shipping it in `VITE_*` or a native app bundle is total compromise. Fix: browser uploads use the
anon key + user session; privileged uploads go through a JWT-verified server endpoint.

**Building paths without the uid prefix.** If paths are not namespaced by `auth.uid()`, the
per-user RLS predicate cannot isolate users and one user can target another's files. Fix: always
build paths as `${user.id}/...` and enforce the prefix in `WITH CHECK`.

**Long-lived signed URLs for PHI or paid content.** A signed URL is checked at sign time, not
fetch time — anyone with the URL can read it until expiry. Fix: short `expiresIn` (15 minutes
for lab reports), re-sign on demand.

**Uploading unoptimized originals and transforming on every render.** Render-time transforms
recompute per distinct size and bill per transformation on hosted plans. Fix: optimize at ingest
for fixed sizes (canvas/WebP downscale, §14).

**Allowing `image/svg+xml` or no MIME restriction on a public bucket.** SVG can embed `<script>`;
served from your origin on a public bucket it is stored XSS or phishing. No `allowed_mime_types`
means any file type, including `text/html`. Fix: set `allowed_mime_types` to raster types only.

**Ignoring the `error` field on storage calls.** supabase-js storage methods return `{ data, error }`
and do not throw — an over-size or RLS-denied upload silently returns `error` while your code
proceeds with `data === null`. Fix: check `error` after every storage call.

**Deleting `storage.objects` rows directly via SQL.** Removing the metadata row does not delete
the S3 bytes, orphaning storage you keep paying for. Fix: always delete through the Storage API
(`remove([...])`), which removes both the row and the bytes.

**Treating "folders" as real.** `remove(['reports/'])` deletes nothing useful. Fix: recursively
`list()` the prefix, collect all object paths, and `remove()` them in chunks (§7).

**Overwriting a stable path and wondering why the old content still shows.** CDN/browser caches
the URL. Fix: use immutable unguessable paths + a pointer column + delete-old (§5), or
cache-bust with `?v=<ts>` and short `cacheControl`.

**Using the wrong `chunkSize` for resumable uploads.** Supabase's TUS implementation requires
exactly 6 MiB chunks; other sizes fail. Fix: set `chunkSize: 6 * 1024 * 1024` (§8).

**Calling `auth.uid()` raw inside storage policies on large buckets.** Per-row evaluation turns
`list()` and bulk `remove()` into slow scans. Fix: wrap as `(select auth.uid())` and put
`bucket_id = '...'` as the first predicate.

**Reusing the auth client (`backend/client.ts`) for Storage operations.** That client is scoped
solely to `auth.getUser()`. Fix: create a separate admin client with `persistSession: false` for
Storage ops (§16).

**Persisting an uploaded lab report when it is PHI-adjacent and the scope does not require it.**
The current multimodal pass-through is correct for the current scope. Fix: only add Storage if
users genuinely need to retrieve past uploads; when you do, follow the blueprint in §18.

---

## 20. See Also

Within this skill:

- `lumina-supabase-in-this-repo.md` — how Lumina currently uses Supabase (auth + Realtime only);
  the division of labor between Prisma and Supabase; `backend/client.ts` and `backend/auth.ts`
  deep dives; why Storage is explicitly not yet used.
- `theory-supabase-architecture.md` — keys (anon/service-role), PostgREST/GoTrue, the platform
  model that underpins Storage.
- `theory-row-level-security-model.md` — the authorization mental model: `USING` vs `WITH CHECK`,
  roles, `(select auth.uid())`, performance.
- `patterns-rls-policies.md` — RLS performance, `SECURITY DEFINER` + pinned `search_path`, policy
  testing — all apply to `storage.objects`.
- `patterns-client-setup-and-config.md` — `createClient`, anon vs service-role separation, server
  vs browser clients.
- `patterns-edge-functions.md` — Deno `Deno.serve`, secrets via env, CORS, JWT verification (the
  service-role upload pattern in a Deno context).
- `patterns-auth-flows.md` — sessions, `getClaims()`, custom claims used in role/claim-based
  storage policies.
- `patterns-cli-migrations-and-types.md` — creating buckets/policies in versioned migrations.

Other skills:

- `health-discover` — the current multimodal lab-report upload path (`fileToAttachment` →
  `buildAttachmentParts` → `streamText` — no Storage involved). Read before adding persistence.
- `prisma` — the Prisma `LabReport` model you would add in a Storage migration; `backend/db.ts`
  singleton; schema conventions (`@map`, `@@map`, explicit `.js` ESM imports).
- `rag-retrieval` — the semantic cache guard (`parts.length === 0` in `backend/index.ts:534`)
  that keeps health uploads out of the shared query cache.
- `backend-testing` — how to mock `supabase.storage` in tests alongside the existing
  `supabase-fake.ts` seam.
- `lumina-frontend` — TanStack Query auth headers, how the React app holds the Supabase session,
  and how upload progress UX would fit in the existing chat / discover shell.
- `connectors-oauth` — the existing pattern for server-side OAuth token storage in Prisma
  (`GmailConnection` model) — a direct analogue to storing `LabReport` storage pointers.
