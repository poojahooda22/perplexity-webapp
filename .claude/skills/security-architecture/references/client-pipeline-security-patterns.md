# Client-Pipeline Security Patterns

> Comprehensive security reference for apps with a rich client-side render/compute pipeline,
> file uploads, and canvas/asset export. Covers CSP, upload sanitization, untrusted-code safety,
> CORS, client-context security, and export protection. Applies to any app that decodes
> user media, executes generated code/expressions on the client, or reads pixels back from a canvas.

---

## Table of Contents

1. [CSP for Rich Client Applications](#csp-for-rich-client-applications)
2. [User Upload Sanitization](#user-upload-sanitization)
3. [Untrusted Code Execution Prevention](#untrusted-code-execution-prevention)
4. [CORS for Asset Loading](#cors-for-asset-loading)
5. [Client Context Security](#client-context-security)
6. [Export Security](#export-security)
7. [Structured-Document Security](#structured-document-security)
8. [Runtime Resource Limits](#runtime-resource-limits)
9. [Monitoring and Incident Response](#monitoring-and-incident-response)

---

## CSP for Rich Client Applications

### Why CSP Matters Here

Content Security Policy controls which resources the browser can load and execute.
Apps with a client-side render/compute pipeline have a few extra CSP requirements because:

- Some payloads look like code but are NOT JavaScript — they are passed to an API as data
  (e.g. a string handed to a renderer/parser), not executed by the JS engine
- Canvas operations produce `blob:` and `data:` URLs for media/export workflows
- Utility-CSS and CSS-in-JS frameworks require inline styles
- The pipeline loads media, models, and other assets that may be cross-origin

### Recommended CSP Header

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: <your-asset-cdn-origin>;
  connect-src 'self' <your-api-origins>;
  font-src 'self' https://fonts.gstatic.com;
  worker-src 'self' blob:;
  frame-ancestors 'self';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
  upgrade-insecure-requests;
```

> Replace `<your-asset-cdn-origin>` and `<your-api-origins>` with the actual origins for your
> deployment (your API host, your blob/object-storage host). Keep the allowlist as narrow as possible.

### Directive Breakdown

| Directive | Value | Rationale |
|-----------|-------|-----------|
| `default-src` | `'self'` | Deny everything not explicitly allowed |
| `script-src` | `'self'` | No inline scripts, no eval. Renderer/parser data strings are NOT scripts |
| `style-src` | `'self' 'unsafe-inline'` | Utility-CSS frameworks generate inline styles at runtime |
| `img-src` | `'self' data: blob:` | Base64 media (`data:`), canvas exports (`blob:`) |
| `connect-src` | `'self' + API domains` | API calls, asset loading, WebSocket if needed |
| `font-src` | `'self' + web fonts` | Web fonts for the editor/UI |
| `worker-src` | `'self' blob:` | Web Workers for offloading computation |
| `frame-ancestors` | `'self'` | Prevent clickjacking by disallowing iframe embedding |
| `object-src` | `'none'` | No Flash, no plugins, no embeds |

### Common Mistakes

- **DO NOT** add `'unsafe-eval'` unless a hard dependency requires it — most rich client apps do
  not. If something breaks without it, the problem is usually in your JS code, not the pipeline.
- **DO NOT** use `'unsafe-inline'` for `script-src` — this defeats the purpose of CSP.
- **DO NOT** use wildcard `*` for `img-src` — this allows loading images from any domain,
  which enables tracking pixels and data exfiltration via image URLs.
- **DO** test CSP in report-only mode first: `Content-Security-Policy-Report-Only`

### Framework Implementation

```typescript
// security headers in your app/framework config
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' <your-api-origins>",
      "font-src 'self' https://fonts.gstatic.com",
      "worker-src 'self' blob:",
      "frame-ancestors 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];
```

---

## User Upload Sanitization

### Threat Landscape

User uploads are the #1 attack vector in any web application that accepts files.
When uploads are decoded and bound into a client pipeline (textures, media, document
inputs), malicious files get decoded by the browser/OS decoders. Decoder bugs +
malicious media = potential code execution.

### File Type Allowlist

| Type | Extension | Magic Bytes (hex) | Notes |
|------|-----------|-------------------|-------|
| PNG | .png | 89 50 4E 47 | Safe raster format |
| JPEG | .jpg/.jpeg | FF D8 FF | Safe raster format |
| WebP | .webp | 52 49 46 46 ... 57 45 42 50 | Safe raster format |
| MP4 | .mp4 | 00 00 00 .. 66 74 79 70 | Video, validate codec |
| WebM | .webm | 1A 45 DF A3 | Video, validate codec |

### Explicitly Blocked

| Type | Why |
|------|-----|
| SVG | Can contain JavaScript, CSS, external references, and SSRF payloads |
| GIF | Limited use, potential for decompression bombs |
| TIFF | Complex format, historically buggy parsers, large file sizes |
| BMP | No compression, potential for oversized payloads |
| PDF | Can embed JavaScript and executable content |
| EXE/DLL | Obviously |

### Magic Byte Validation

```typescript
// Validate file signature (magic bytes) -- NEVER trust file extension alone
const MAGIC_BYTES: Record<string, number[]> = {
  png:  [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  jpeg: [0xFF, 0xD8, 0xFF],
  webp: [0x52, 0x49, 0x46, 0x46],  // RIFF header, check bytes 8-11 for WEBP
  mp4:  [0x66, 0x74, 0x79, 0x70],  // ftyp at offset 4
  webm: [0x1A, 0x45, 0xDF, 0xA3],
};

function validateMagicBytes(buffer: ArrayBuffer, expectedType: string): boolean {
  const bytes = new Uint8Array(buffer);
  const expected = MAGIC_BYTES[expectedType];
  if (!expected) return false;

  // For mp4, check at offset 4
  const offset = expectedType === "mp4" ? 4 : 0;
  return expected.every((b, i) => bytes[offset + i] === b);
}
```

### SVG Sanitization (If SVG Support Is Ever Added)

SVG is XML that can contain:
- `<script>` tags with JavaScript
- `onload`, `onerror`, and other event handlers
- `<foreignObject>` embedding arbitrary HTML
- `xlink:href` referencing external resources (SSRF)
- CSS `url()` functions loading external resources
- `<use>` elements referencing external SVGs

**Recommended default policy: SVG uploads are REJECTED.** If SVG support is required:

1. Parse with DOMParser in a sandboxed iframe (no network access)
2. Walk the entire DOM tree and remove ALL script elements, event handlers, and
   `foreignObject` elements
3. Remove all `xlink:href` and `href` attributes pointing to external URLs
4. Remove all CSS `url()` references
5. Better yet: rasterize to PNG server-side using a headless browser in a
   sandboxed container, and serve the PNG instead

### Image Dimension Limits

```typescript
const MAX_IMAGE_DIMENSIONS = {
  width: 4096,    // Common max texture/decode size on most hardware
  height: 4096,
  megapixels: 16, // 4096 * 4096 = 16.7M -- cap at 16M
  fileSize: 20 * 1024 * 1024, // 20MB max file size
};

async function validateImageDimensions(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const valid =
        img.width <= MAX_IMAGE_DIMENSIONS.width &&
        img.height <= MAX_IMAGE_DIMENSIONS.height &&
        img.width * img.height <= MAX_IMAGE_DIMENSIONS.megapixels * 1_000_000;
      URL.revokeObjectURL(img.src);
      resolve(valid);
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      resolve(false);
    };
    img.src = URL.createObjectURL(file);
  });
}
```

### EXIF Stripping

All uploaded images must have EXIF metadata stripped before storage:
- GPS coordinates (privacy: reveals user location)
- Device model and serial number (privacy: identifies device)
- Timestamps (privacy: reveals when photo was taken)
- Thumbnail data (can contain unredacted original)

Use server-side processing with Sharp or similar:

```typescript
// Server-side: strip EXIF and re-encode
import sharp from "sharp";

async function sanitizeImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()           // Apply EXIF orientation before stripping
    .removeAlpha()      // Optional: remove alpha if not needed
    .withMetadata({ })  // Strip all metadata
    .toFormat("webp", { quality: 85 })
    .toBuffer();
}
```

---

## Untrusted Code Execution Prevention

### Current State (typical)

In many apps, any executable artifacts (compiled programs, render passes, expressions)
are **authored by the dev team** and shipped as part of the application bundle. Users do
NOT write or upload custom code. When that is true, untrusted-code execution is a
**low-risk** threat.

### Future Risk: User-Generated Code/Expressions

If a plugin system or custom code/expression editor is ever introduced, the following
safeguards MUST be implemented. The example below uses a GPU/shader-style compilation
target as the concrete case, but the same pattern applies to ANY sandboxed
compile-and-run boundary — a query language, a formula engine, a sandboxed script:

#### Validation Pipeline

1. **Lexical analysis** — Tokenize the source and reject:
   - Dangerous preprocessor/include directives
   - Infinite loop patterns (`for(;;)`, `while(true)` without a bounded iteration count)
   - Recursive calls into unsupported/unsafe constructs

2. **Compilation sandbox** — Compile in an isolated context:
   - Use a dedicated, throwaway execution context
   - Check the compiler's status/info-log output
   - Destroy the context after validation

3. **Resource limits** — Enforce maximum complexity:
   - Maximum input bindings (prevents resource bombing)
   - Maximum variable/parameter counts
   - Maximum instruction count
   - Maximum loop iterations

```typescript
// Source validation (for a future plugin/expression system)
function validateUntrustedSource(source: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for dangerous patterns
  const dangerousPatterns = [
    { pattern: /for\s*\(\s*;\s*;\s*\)/, message: "Infinite for loop detected" },
    { pattern: /while\s*\(\s*true\s*\)/, message: "Infinite while loop detected" },
    { pattern: /#\s*include/, message: "Preprocessor includes not allowed" },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(source)) {
      errors.push(message);
    }
  }

  // Cap the number of external resource bindings (example: input handles/samplers)
  const bindingCount = (source.match(/\bbinding\b/g) || []).length;
  if (bindingCount > 8) {
    errors.push("Too many resource bindings (max 8, found " + bindingCount + ")");
  }

  return { valid: errors.length === 0, errors };
}
```

### Client Hang Prevention

Client-side compute (GPU work, heavy CPU loops, Web Worker tasks) can hang the device
with infinite loops or extremely complex operations. The browser/driver will eventually
kill the work, but this creates a bad user experience and can crash the tab.

Mitigations:
- Bounded loops only: every loop must have a compile-time-determinable upper bound
- Cap per-unit-of-work complexity (e.g. number of lookups per pass)
- Watchdog timer: if a frame/task takes longer than a budget, reduce quality or skip work

---

## CORS for Asset Loading

### The Problem

When loading cross-origin images/media for canvas readback or texture binding, the
browser enforces CORS. Without proper CORS headers, the asset may upload/draw but:

1. **Succeed silently** — the asset loads but...
2. **Taint the canvas** — `canvas.toDataURL()` and pixel readback throw a security error
3. **No error in console** — the failure is completely silent

This is one of the most frustrating canvas bugs because everything appears to work
until you try to export or read back the rendered frame.

### Solution: Always Set crossOrigin

```typescript
// CORRECT: Set crossOrigin before setting src
function loadAssetImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";  // MUST be set before src
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load asset: " + url));
    img.src = url;
  });
}

// WRONG: Setting crossOrigin after src (or not at all)
// const img = new Image();
// img.src = url;  // Too late -- request already sent without CORS
// img.crossOrigin = "anonymous";
```

### Loader-Library Note

Many asset/texture loader libraries expose a `crossOrigin` setting. Verify it is set
explicitly in your pipeline code rather than relying on framework defaults — silent
canvas tainting is the failure mode when it is not.

### CDN / Object-Storage Configuration

```
# For a custom CDN / object store, configure:

Access-Control-Allow-Origin: <your-app-origin>
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

### Proxy Pattern for Third-Party Assets

If users can reference external images (e.g., paste a URL), proxy through your API:

```typescript
// API route: /api/proxy-image?url=...
// This adds proper CORS headers and validates the image

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");

  if (!url) return new Response("Missing url", { status: 400 });

  // Validate URL -- allowlist of domains or require HTTPS
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    return new Response("HTTPS required", { status: 400 });
  }

  // Fetch and validate
  const response = await fetch(url);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    return new Response("Not an image", { status: 400 });
  }

  // Forward with CORS headers
  const buffer = await response.arrayBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
```

---

## Client Context Security

> The patterns below are written against a GPU/canvas rendering context as the concrete
> example, because that is where they bite hardest. The principles — clear buffers before
> reuse, never store the only copy of user data in a volatile client context, handle context
> loss gracefully, and minimize fingerprintable surface — apply to any volatile client-side
> execution context.

### Context Attributes

```typescript
// Recommended rendering-context attributes for security
const contextAttributes = {
  antialias: true,
  preserveDrawingBuffer: false,  // Set true ONLY when export is needed
  powerPreference: "high-performance",
  failIfMajorPerformanceCaveat: false,
  desynchronized: false,
};
```

### Memory Isolation

A client rendering/compute context does NOT necessarily provide memory isolation
between tabs or contexts. This means:

- Uninitialized buffers may contain data from other contexts (rare but possible)
- Always clear buffers before use before reading them back
- Never store sensitive data (auth tokens, user PII) in client compute buffers
- Buffer contents from one tab could theoretically leak to another

### Context Loss Handling

A client rendering context can be lost at any time when:
- The GPU driver crashes or resets
- Another tab or application consumes too much memory
- The system goes to sleep/hibernate
- The browser decides to reclaim resources

**Security implication:** Never store the ONLY copy of user data in a volatile client
context. Always keep a copy of critical state (document/graph, project data, undo history)
in durable storage.

```typescript
// Handle context loss gracefully
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();  // Allows context restore
  console.warn("Rendering context lost -- suspending rendering");
  // Stop render loop, show user notification
});

canvas.addEventListener("webglcontextrestored", () => {
  console.info("Rendering context restored -- reinitializing");
  // Recreate all client resources
  // Restore from durable state
});
```

### Canvas Fingerprinting Prevention

`canvas.toDataURL()` can be used for browser fingerprinting because rendering
produces slightly different results on different hardware. Mitigations:

- Rate-limit `toDataURL()` calls (max 1 per second for export, 0 for non-export contexts)
- Set `frame-ancestors 'self'` in CSP to prevent embedding in tracking iframes
- Consider adding noise to exported images (imperceptible but breaks fingerprint consistency)
- `preserveDrawingBuffer: false` prevents reading the canvas between frames

### Capability Enumeration

Querying the full capability/extension set of a client rendering context reveals
hardware details that can be used for fingerprinting:

- Only request the specific capabilities you actually need
- Avoid enumerating the full list of supported capabilities/extensions —
  that reveals a complete hardware fingerprint

---

## Export Security

### Source / IP Protection

The exported output of some apps contains proprietary source code or assets. That
output IS the intellectual property of the product. Without protection, competitors
could extract and reuse the algorithms or assets.

### Minification Strategy

```
// Before export, minify internal identifier names.
// Original:
//   internalParam_chromaticAberrationIntensity
//   internalVar_texCoordDistorted
//
// Minified:
//   a
//   b
//
// Implementation: use a minifier or AST transform for the export format.
// Preserve identifiers that are part of the public API.
// Minify internal variables and helper names.
```

### License Header

Every exported file should include:

```
// Generated by <your product>
// License: [license type]
// This file contains proprietary code/assets.
// Unauthorized redistribution is prohibited.
```

### What Must NEVER Be in Exported Output

- API keys or authentication tokens
- User email, name, or any PII
- Server URLs for internal APIs
- Database connection strings
- Debug information (file paths, line numbers from source)
- Comments referencing internal architecture

### Export Rate Limiting

```typescript
// Rate limit export endpoints to prevent bulk scraping
const EXPORT_RATE_LIMIT = {
  windowMs: 60 * 1000,  // 1 minute window
  maxRequests: 10,       // Max 10 exports per minute
  message: "Export rate limit exceeded. Please try again later.",
};
```

### Canvas Data Extraction

When exporting rendered frames:

```typescript
// Safe export workflow
function exportFrame(canvas: HTMLCanvasElement): string {
  // 1. Validate the canvas is from our application
  if (!canvas.dataset.appOwned) {
    throw new Error("Cannot export an unrecognized canvas");
  }

  // 2. Export at requested quality
  const dataUrl = canvas.toDataURL("image/png");

  // 3. Strip any metadata that might leak info
  // PNG toDataURL from canvas does not include EXIF, but verify

  return dataUrl;
}
```

---

## Structured-Document Security

### Serialization Format

Documents (scene graphs, node graphs, project files) are stored as JSON. The schema
must be strictly validated on both save and load to prevent injection attacks.

### Schema Validation

```typescript
// Validate document structure before deserialization
import { z } from "zod";

const NodeSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["source", "filter", "blend", "output"]),  // Strict enum
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  data: z.record(z.union([z.string(), z.number(), z.boolean()])),
  // NO arbitrary objects, NO functions, NO code strings
});

const EdgeSchema = z.object({
  id: z.string().uuid(),
  source: z.string().uuid(),
  target: z.string().uuid(),
  sourceHandle: z.string().max(64),
  targetHandle: z.string().max(64),
});

const GraphSchema = z.object({
  nodes: z.array(NodeSchema).max(500),      // Max 500 nodes
  edges: z.array(EdgeSchema).max(2000),     // Max 2000 connections
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().min(0.1).max(10),
  }),
});
```

### String Sanitization

Any string property from the document that will be rendered in the DOM must be
sanitized against XSS:

```typescript
// Sanitize labels and other user-visible strings
function sanitizeLabel(label: string): string {
  return label
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .slice(0, 100);  // Max 100 chars for labels
}
```

### Document Size Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max items | 500 | Prevent DoS via massive document processing |
| Max connections | 2,000 | Prevent combinatorial explosion in execution |
| Max depth | 50 | Prevent stack overflow in recursive traversal |
| Max string length | 1,000 | Prevent memory exhaustion via long strings |
| Max file size | 5 MB | Prevent upload of oversized document files |

---

## Runtime Resource Limits

### Pipeline Pass Limits

```typescript
const PIPELINE_LIMITS = {
  maxPasses: 32,           // Maximum processing passes per frame
  maxResourceUnits: 16,    // Maximum bound resources per pass
  maxBufferSize: 4096,     // Maximum buffer dimension
  maxFrameTime: 100,       // Maximum ms per frame before quality reduction
  maxMemoryMB: 512,        // Maximum estimated memory usage
};
```

### Frame Budget Watchdog

```typescript
// Monitor frame times and reduce quality if the client is struggling
class FrameBudgetWatchdog {
  private frameTimes: number[] = [];
  private readonly maxFrameTime: number;
  private readonly windowSize = 10;

  constructor(maxFrameTimeMs: number = 100) {
    this.maxFrameTime = maxFrameTimeMs;
  }

  recordFrame(durationMs: number): { shouldReduceQuality: boolean } {
    this.frameTimes.push(durationMs);
    if (this.frameTimes.length > this.windowSize) {
      this.frameTimes.shift();
    }

    const avgFrameTime =
      this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;

    return { shouldReduceQuality: avgFrameTime > this.maxFrameTime };
  }
}
```

---

## Monitoring and Incident Response

### Security Events to Monitor

| Event | Severity | Action |
|-------|----------|--------|
| CSP violation report | INFO | Log and review weekly |
| Failed upload validation | WARN | Log with IP, review for patterns |
| Document schema violation | WARN | Log with user ID, block save |
| Export rate limit hit | INFO | Log, alert if sustained |
| Client context lost | INFO | Log device/driver info for debugging |
| Compilation/parse error on untrusted input | WARN | Log a hash of the source (not full source) |
| Authentication failure on API | WARN | Rate limit, alert after 5 failures |
| Oversized request body | WARN | Block, log source IP |

### CSP Violation Reporting

```typescript
// Report CSP violations to your monitoring endpoint
// In your security-headers config:
{
  key: "Content-Security-Policy-Report-Only",
  value: "...; report-uri /api/csp-report; report-to csp-endpoint",
}

// API route to collect reports
export async function POST(request: Request) {
  const report = await request.json();
  console.warn("CSP violation:", JSON.stringify(report));
  // Forward to monitoring service (Sentry, Datadog, etc.)
  return new Response(null, { status: 204 });
}
```

### Dependency Auditing

```bash
# Run regularly (weekly minimum, ideally in CI)
npm audit --production
npx audit-ci --moderate  # Fail CI on moderate+ vulnerabilities

# Pay special attention to libraries with direct hardware/decoder access
# (rendering, media-decode, native bindings) -- vulnerabilities there are HIGH severity
```

---

## Appendix: Rich-Client Security Compared to Standard Web Apps

| Concern | Standard Web App | Rich-Client / Pipeline App |
|---------|-----------------|----------------------------|
| XSS | HTML injection, DOM manipulation | Same + untrusted-code injection (if user code is allowed) |
| File uploads | Server-side processing | Server-side + client-side media decoding |
| DoS | CPU/memory exhaustion | CPU + GPU/client exhaustion, context loss |
| IP theft | Source code in bundle | Source code + proprietary pipeline algorithms in export |
| Fingerprinting | Cookies, localStorage | Canvas fingerprinting, hardware capability enumeration |
| CORS | API calls | API calls + asset loading (silent canvas tainting) |
| CSP | Standard directives | Standard + blob:/data: for canvas operations |
| Memory | JS heap | JS heap + client compute memory (no isolation guarantee) |
| Data loss | Server crash | Server crash + client context loss |
