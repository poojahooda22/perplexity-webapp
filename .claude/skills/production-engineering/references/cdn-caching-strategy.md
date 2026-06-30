# CDN and Caching Strategy for WebGL Applications

> Shader source caching, primitive JSON caching, Vercel edge caching, cache invalidation, service workers, CDN configuration, and CORS for cross-origin textures in production WebGL apps.

## Table of Contents

1. [Caching Architecture Overview](#caching-architecture-overview)
2. [Shader Source Caching](#shader-source-caching)
3. [Primitive JSON Caching](#primitive-json-caching)
4. [Vercel Edge Caching](#vercel-edge-caching)
5. [Cache Invalidation Strategy](#cache-invalidation-strategy)
6. [Service Worker for Offline Shader Cache](#service-worker-for-offline-shader-cache)
7. [CDN Configuration for WebGL Assets](#cdn-configuration-for-webgl-assets)
8. [CORS for Cross-Origin Textures](#cors-for-cross-origin-textures)
9. [HTTP/2 and HTTP/3 Optimization](#http2-and-http3-optimization)
10. [Cache Debugging and Monitoring](#cache-debugging-and-monitoring)

---

## Caching Architecture Overview

### Cache Layers

```
User Request
  |
  v
Browser Cache (memory + disk)
  |  miss
  v
Service Worker Cache
  |  miss
  v
Vercel Edge Network (300+ locations)
  |  miss
  v
Vercel Origin (serverless function or static file)
```

### Asset Classification for Cache Strategy

```
Asset Type              Mutability    Cache Strategy           TTL
---                     ---           ---                      ---
JS bundles              Immutable     Content-hash filename    1 year
CSS files               Immutable     Content-hash filename    1 year
GLSL shader strings     Immutable*    Content-hash filename    1 year
Primitive JSON configs  Immutable*    Content-hash filename    1 year
Texture images (PNG)    Immutable*    Content-hash filename    1 year
WASM modules            Immutable     Content-hash filename    1 year
HTML pages              Mutable       Revalidate               0 (always fresh)
API responses           Mutable       stale-while-revalidate   5 min
Font files              Immutable     Long cache + immutable   1 year

* Immutable PER VERSION. When content changes, a new filename is generated.
```

### The Golden Rule

```
Content-addressable files (hash in filename) -> Cache forever (immutable)
Non-content-addressable files (same URL)     -> Short TTL + revalidation
```

---

## Shader Source Caching

### Content-Hash Filenames for Shaders

When shaders are bundled as separate chunks (via dynamic import), webpack
automatically adds content hashes to filenames:

```
.next/static/chunks/shader-bloom-a3f2c8d1.js
.next/static/chunks/shader-blur-7b4e9f23.js
```

These files can be cached forever because changing the shader content changes the hash.

### Shader Source as Static Assets

If shaders are served as raw GLSL files (not bundled into JS):

```typescript
// scripts/hash-shaders.mjs
// Generate content-hashed shader filenames during build

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { createHash } from 'crypto';
import { globSync } from 'glob';
import { basename, join } from 'path';

const SHADER_DIR = 'lib/shaders';
const OUTPUT_DIR = 'public/shaders';
const MANIFEST_PATH = 'lib/shaders/manifest.json';

mkdirSync(OUTPUT_DIR, { recursive: true });

const manifest: Record<string, string> = {};

const files = globSync(`${SHADER_DIR}/**/*.glsl`);

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const name = basename(file, '.glsl');
  const hashedName = `${name}-${hash}.glsl`;

  copyFileSync(file, join(OUTPUT_DIR, hashedName));
  manifest[name] = `/shaders/${hashedName}`;
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log(`Hashed ${files.length} shaders -> ${MANIFEST_PATH}`);
```

```typescript
// lib/shaders/loadShader.ts

import manifest from './manifest.json';

const cache = new Map<string, string>();

export async function loadShader(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  const url = manifest[name as keyof typeof manifest];
  if (!url) throw new Error(`Unknown shader: ${name}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load shader: ${url}`);

  const source = await response.text();
  cache.set(name, source);
  return source;
}
```

### Cache Headers for Shader Files

```json
// vercel.json
{
  "headers": [
    {
      "source": "/shaders/:path*",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        },
        {
          "key": "Content-Type",
          "value": "text/plain; charset=utf-8"
        }
      ]
    }
  ]
}
```

---

## Primitive JSON Caching

### Static Generation for Primitive Definitions

Primitive definitions (effect parameter schemas, default values, metadata)
are known at build time. Generate static JSON files.

```typescript
// scripts/generate-primitives.mjs

import { writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

// Import all primitive definitions
import { primitiveRegistry } from '../lib/primitives/registry';

const OUTPUT_DIR = 'public/primitives';
mkdirSync(OUTPUT_DIR, { recursive: true });

const manifest: Record<string, string> = {};

for (const [type, definition] of Object.entries(primitiveRegistry)) {
  const json = JSON.stringify(definition);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 12);
  const filename = `${type}-${hash}.json`;

  writeFileSync(`${OUTPUT_DIR}/${filename}`, json);
  manifest[type] = `/primitives/${filename}`;
}

// Write manifest
writeFileSync(
  `${OUTPUT_DIR}/manifest.json`,
  JSON.stringify(manifest, null, 2)
);

console.log(`Generated ${Object.keys(manifest).length} primitive files`);
```

### Cache Headers for Primitive JSON

```json
// vercel.json
{
  "headers": [
    {
      "source": "/primitives/:path*.json",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
```

### Inlining Small Primitives

For small primitive definitions (< 2KB), consider inlining them in the JS bundle
rather than making a separate HTTP request. The overhead of an HTTP request
(DNS, TLS, round trip) outweighs the savings of caching a 2KB file.

```typescript
// lib/primitives/inlinedPrimitives.ts

// These are small enough to inline (< 2KB each)
export const INLINE_PRIMITIVES = {
  vignette: { type: 'vignette', props: { /* ... */ }, /* ... */ },
  grain: { type: 'grain', props: { /* ... */ }, /* ... */ },
  brightness: { type: 'brightness', props: { /* ... */ }, /* ... */ },
} as const;

// These are larger and should be loaded on demand
export const LAZY_PRIMITIVE_TYPES = [
  'bloom',
  'fog',
  'blobTracking',
  'progressiveBlur',
] as const;
```

---

## Vercel Edge Caching

### How Vercel Edge Caching Works

Vercel's edge network has 300+ points of presence (PoPs). When a user requests
a static asset:

1. Request hits the nearest PoP
2. If the asset is cached at the edge, it is served immediately (~10ms)
3. If not cached, the request goes to the origin, response is cached at the edge

### Cache-Control Headers for Vercel

```typescript
// app/api/primitives/[type]/route.ts

import { NextResponse } from 'next/server';

export async function GET(
  request: Request,
  { params }: { params: { type: string } }
) {
  const primitive = await loadPrimitive(params.type);

  if (!primitive) {
    return NextResponse.json(
      { error: 'Primitive not found' },
      { status: 404 }
    );
  }

  return NextResponse.json(primitive, {
    headers: {
      // Cache at the edge for 1 hour, serve stale while revalidating
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      // Vary by nothing (response is the same for all users)
      'Vary': '',
    },
  });
}
```

### Static Asset Headers in vercel.json

```json
// vercel.json
{
  "headers": [
    {
      "source": "/(.*)\\.js",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/(.*)\\.css",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/(.*)\\.woff2",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/textures/:path*",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/shaders/:path*",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/primitives/:path*",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
```

### Vercel Edge Config for Feature Flags

```typescript
// lib/config/edgeConfig.ts

import { get } from '@vercel/edge-config';

/**
 * Use Vercel Edge Config for feature flags that affect GPU behavior.
 * Edge Config is read from the nearest PoP with ~1ms latency.
 */
export async function getGPUFeatureFlags(): Promise<{
  maxLayers: number;
  enableBloom: boolean;
  enableFog: boolean;
  defaultQuality: 'low' | 'medium' | 'high';
}> {
  const flags = await get('gpu-features');

  return {
    maxLayers: (flags as any)?.maxLayers ?? 20,
    enableBloom: (flags as any)?.enableBloom ?? true,
    enableFog: (flags as any)?.enableFog ?? true,
    defaultQuality: (flags as any)?.defaultQuality ?? 'medium',
  };
}
```

---

## Cache Invalidation Strategy

### Content-Hash Based Invalidation

This is the primary strategy. When file content changes, the hash changes,
producing a new URL. Old URLs remain valid (serving old content) until
they naturally expire from the edge cache.

```
Before update:  /shaders/bloom-a3f2c8d1.glsl  (cached forever)
After update:   /shaders/bloom-7b4e9f23.glsl  (new URL, fetched fresh)
Old file:       /shaders/bloom-a3f2c8d1.glsl  (still valid, still cached)
```

No active cache purging is needed. This is the safest strategy.

### Manifest-Based Cache Busting

```typescript
// lib/cache/manifestCache.ts

/**
 * The manifest maps logical names to content-hashed URLs.
 * The manifest itself is embedded in the JS bundle (which has its own hash).
 * When any primitive changes, the JS bundle hash changes, pulling the new manifest.
 *
 * Flow:
 * 1. Build step generates content-hashed files + manifest
 * 2. Manifest is imported into the app bundle
 * 3. App bundle gets a new hash (because manifest changed)
 * 4. User loads new bundle -> gets new manifest -> fetches new assets
 */

interface AssetManifest {
  shaders: Record<string, string>;
  primitives: Record<string, string>;
  textures: Record<string, string>;
}

let _manifest: AssetManifest | null = null;

export function getManifest(): AssetManifest {
  if (!_manifest) {
    // In production, this is a static import resolved at build time
    _manifest = require('../../../public/asset-manifest.json');
  }
  return _manifest!;
}

export function getShaderUrl(name: string): string {
  const url = getManifest().shaders[name];
  if (!url) throw new Error(`Shader not in manifest: ${name}`);
  return url;
}

export function getPrimitiveUrl(type: string): string {
  const url = getManifest().primitives[type];
  if (!url) throw new Error(`Primitive not in manifest: ${type}`);
  return url;
}
```

### Vercel Cache Purging (Emergency)

In emergencies (bad asset deployed), purge the Vercel edge cache:

```bash
# Purge specific paths
vercel cache purge /shaders/bloom-a3f2c8d1.glsl

# Purge all (nuclear option)
vercel cache purge --all

# Or redeploy (triggers cache invalidation for all assets)
vercel --prod
```

### Browser Cache Busting

For the rare case where a user has a stale browser cache:

```typescript
// lib/cache/bustCache.ts

/**
 * Force-refresh a cached resource by adding a cache-busting query parameter.
 * Use sparingly -- only when you know the browser has a stale copy.
 */
export function bustCacheUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_cb=${Date.now()}`;
}
```

---

## Service Worker for Offline Shader Cache

### Service Worker Registration

```typescript
// lib/sw/register.ts

export function registerServiceWorker(): void {
  if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(
        (registration) => {
          console.info('[SW] Registered:', registration.scope);
        },
        (error) => {
          console.warn('[SW] Registration failed:', error);
          // Service worker failure should never break the app
        }
      );
    });
  }
}
```

### Service Worker Implementation

```javascript
// public/sw.js

const CACHE_NAME = 'webgl-app-v1';

// Assets to pre-cache during install
const PRECACHE_ASSETS = [
  // Core shaders that are always needed
  // These URLs come from the build manifest
];

// Cache strategies by URL pattern
const CACHE_STRATEGIES = [
  {
    // Shader files: cache-first (immutable)
    pattern: /\/shaders\/.+\.glsl$/,
    strategy: 'cache-first',
  },
  {
    // Primitive JSON: cache-first (immutable)
    pattern: /\/primitives\/.+\.json$/,
    strategy: 'cache-first',
  },
  {
    // Texture images: cache-first (immutable)
    pattern: /\/textures\/.+\.(png|jpg|ktx2)$/,
    strategy: 'cache-first',
  },
  {
    // WASM modules: cache-first (immutable)
    pattern: /\.wasm$/,
    strategy: 'cache-first',
  },
  {
    // JS/CSS bundles: cache-first (content-hashed)
    pattern: /\/_next\/static\/.+\.(js|css)$/,
    strategy: 'cache-first',
  },
  {
    // HTML pages: network-first (always get latest)
    pattern: /\/$/,
    strategy: 'network-first',
  },
  {
    // API calls: network-only (real-time data)
    pattern: /\/api\//,
    strategy: 'network-only',
  },
];

// Install: pre-cache critical assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
  // Activate immediately (don't wait for old SW to die)
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Claim all clients immediately
  self.clients.claim();
});

// Fetch: apply cache strategy based on URL pattern
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const matched = CACHE_STRATEGIES.find((s) => s.pattern.test(url.pathname));
  const strategy = matched?.strategy || 'network-first';

  switch (strategy) {
    case 'cache-first':
      event.respondWith(cacheFirst(event.request));
      break;
    case 'network-first':
      event.respondWith(networkFirst(event.request));
      break;
    case 'network-only':
      // Do nothing, let the browser handle it
      break;
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}
```

### Cache Size Management

```javascript
// Inside sw.js

/**
 * Limit cache size to prevent filling the user's storage.
 * Service worker storage is shared with the page and subject to quotas.
 */
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();

  if (keys.length > maxItems) {
    // Delete oldest entries (FIFO)
    const toDelete = keys.slice(0, keys.length - maxItems);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// Run trim periodically
setInterval(() => {
  trimCache(CACHE_NAME, 200); // Keep at most 200 cached items
}, 60000);
```

---

## CDN Configuration for WebGL Assets

### Vercel CDN (Default)

Vercel's CDN is automatic for all deployments. Key features:
- Global edge network (300+ PoPs)
- Automatic Brotli/gzip compression
- HTTP/2 and HTTP/3 support
- Automatic TLS
- Smart routing (routes to nearest origin)

No additional CDN is needed for most WebGL apps on Vercel.

### Custom Domain CDN Headers

```json
// vercel.json

{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        }
      ]
    },
    {
      "source": "/_next/static/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
```

### Asset Preloading

```tsx
// app/editor/page.tsx

import Head from 'next/head';

export default function EditorPage() {
  return (
    <>
      <Head>
        {/* Preload critical shader sources */}
        <link
          rel="preload"
          href="/shaders/common-utils.glsl"
          as="fetch"
          crossOrigin="anonymous"
        />

        {/* Preload WASM for texture decompression */}
        <link
          rel="preload"
          href="/libs/basis/basis_transcoder.wasm"
          as="fetch"
          crossOrigin="anonymous"
          type="application/wasm"
        />

        {/* Preload font for editor UI */}
        <link
          rel="preload"
          href="/fonts/inter-latin-400.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />

        {/* DNS prefetch for any external texture CDN */}
        <link rel="dns-prefetch" href="https://textures.example.com" />
      </Head>
      <EditorCanvas />
    </>
  );
}
```

---

## CORS for Cross-Origin Textures

### The Problem

WebGL requires CORS headers to use cross-origin images as textures.
Without proper CORS, `gl.texImage2D()` will throw a security error.

```
SecurityError: The operation is insecure.
```

This happens because WebGL can read pixel data from textures (via readPixels
or framebuffer operations). If the texture came from a different origin without
CORS, reading its pixels would be a cross-origin data leak.

### Setting CORS on Texture Responses

```json
// vercel.json - for textures served from your own domain
{
  "headers": [
    {
      "source": "/textures/:path*",
      "headers": [
        {
          "key": "Access-Control-Allow-Origin",
          "value": "*"
        },
        {
          "key": "Access-Control-Allow-Methods",
          "value": "GET"
        },
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
```

### Loading Cross-Origin Textures in Three.js

```typescript
// lib/textures/crossOriginLoader.ts

import * as THREE from 'three';

/**
 * Load a texture from a cross-origin URL with proper CORS handling.
 */
export function loadCrossOriginTexture(
  url: string,
  onLoad?: (texture: THREE.Texture) => void,
  onError?: (error: Error) => void
): THREE.Texture {
  const loader = new THREE.TextureLoader();

  // CRITICAL: Set crossOrigin to enable CORS
  loader.setCrossOrigin('anonymous');

  return loader.load(
    url,
    (texture) => {
      // Ensure correct color space for sRGB images
      texture.colorSpace = THREE.SRGBColorSpace;
      onLoad?.(texture);
    },
    undefined, // onProgress (deprecated)
    (error) => {
      console.error(`[TextureLoader] Failed to load ${url}:`, error);
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  );
}

/**
 * Load a texture as a data texture (bypass CORS by fetching as blob).
 * Use when the remote server does not support CORS but you control the proxy.
 */
export async function loadTextureViaProxy(
  originalUrl: string,
  proxyBase: string = '/api/proxy-texture'
): Promise<THREE.Texture> {
  const proxyUrl = `${proxyBase}?url=${encodeURIComponent(originalUrl)}`;
  const response = await fetch(proxyUrl);

  if (!response.ok) {
    throw new Error(`Proxy fetch failed: ${response.status}`);
  }

  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  const texture = new THREE.CanvasTexture(imageBitmap as any);
  texture.needsUpdate = true;
  return texture;
}
```

### Texture Proxy API Route

```typescript
// app/api/proxy-texture/route.ts

import { NextResponse } from 'next/server';

const ALLOWED_ORIGINS = [
  'https://images.unsplash.com',
  'https://cdn.example.com',
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  // Validate the URL is from an allowed origin
  const parsed = new URL(url);
  if (!ALLOWED_ORIGINS.includes(parsed.origin)) {
    return NextResponse.json(
      { error: 'Origin not allowed' },
      { status: 403 }
    );
  }

  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type') || 'image/png';

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // Cache for 1 day
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch texture' },
      { status: 502 }
    );
  }
}
```

### Canvas Tainting Rules

```
Rule: If ANY texture loaded without CORS is used in the WebGL context,
the entire canvas becomes "tainted" and:
- canvas.toDataURL() throws
- canvas.toBlob() throws
- gl.readPixels() may throw or return zeros
- Any framebuffer operation reading from the tainted texture fails

Prevention:
- ALWAYS set crossOrigin="anonymous" on TextureLoader
- ALWAYS ensure CORS headers on texture responses
- Use a proxy for third-party textures without CORS
- Test with canvas.toDataURL() to detect tainting early
```

---

## HTTP/2 and HTTP/3 Optimization

### Multiplexing Benefits for WebGL

HTTP/2 multiplexing allows many small requests over a single connection.
This benefits WebGL apps that load many small assets:

```
Separate files (HTTP/2 optimized):
- 20 shader files x 2KB each = 20 requests over 1 connection
- Browser can start using each shader as it arrives
- Failed shader does not block others

Single bundle (HTTP/1.1 optimized):
- 1 large file with all shaders = 1 request
- Must wait for entire file before using any shader
- Failure requires re-downloading everything
```

### Resource Hints for HTTP/2

```html
<!-- Preconnect to establish the TLS connection early -->
<link rel="preconnect" href="https://your-domain.vercel.app" />

<!-- Preload critical assets that will be needed immediately -->
<link rel="preload" href="/_next/static/chunks/main-abc123.js" as="script" />

<!-- Prefetch assets needed for the next navigation -->
<link rel="prefetch" href="/editor" />
```

### HTTP/3 (QUIC) on Vercel

Vercel supports HTTP/3 automatically. Benefits for WebGL:
- Faster connection establishment (0-RTT)
- No head-of-line blocking (unlike HTTP/2 over TCP)
- Better performance on lossy networks (mobile)

No configuration needed. The browser and Vercel negotiate HTTP/3 automatically.

---

## Cache Debugging and Monitoring

### Verifying Cache Headers

```bash
# Check cache headers for a specific URL
curl -I https://your-app.vercel.app/shaders/bloom-a3f2c8d1.glsl

# Expected output:
# HTTP/2 200
# cache-control: public, max-age=31536000, immutable
# content-type: text/plain; charset=utf-8
# x-vercel-cache: HIT   <-- Served from edge cache
```

### Vercel Cache Status Headers

```
x-vercel-cache: HIT      -> Served from edge cache (fast)
x-vercel-cache: MISS     -> Fetched from origin, now cached at edge
x-vercel-cache: STALE    -> Served stale while revalidating in background
x-vercel-cache: BYPASS   -> Cache was bypassed (e.g., POST request)
x-vercel-cache: PRERENDER -> Served from ISR/SSG cache
```

### Browser DevTools Cache Inspection

```
Chrome DevTools > Network tab:
- "Size" column shows "(disk cache)" or "(memory cache)" for cached resources
- "Time" column shows 0ms for cached resources
- Filter by "Type: JS" to see bundle caching
- Filter by "Type: Img" to see texture caching
- Right-click > "Clear browser cache" to test cold load

Chrome DevTools > Application tab:
- Cache Storage: Shows Service Worker caches
- Storage: Shows overall storage usage
```

### Cache Hit Rate Monitoring

```typescript
// lib/cache/cacheMonitor.ts

interface CacheStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
}

const stats: CacheStats = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  hitRate: 0,
};

/**
 * Monitor cache effectiveness using the Resource Timing API.
 * transferSize === 0 indicates the resource was served from cache.
 */
export function startCacheMonitoring(): () => void {
  if (!('PerformanceObserver' in window)) return () => {};

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      // Only track our asset types
      if (
        entry.name.includes('/shaders/') ||
        entry.name.includes('/primitives/') ||
        entry.name.includes('/textures/') ||
        entry.name.includes('/_next/static/')
      ) {
        stats.totalRequests += 1;

        if (entry.transferSize === 0) {
          stats.cacheHits += 1;
        } else {
          stats.cacheMisses += 1;
        }

        stats.hitRate =
          stats.totalRequests > 0
            ? stats.cacheHits / stats.totalRequests
            : 0;
      }
    }
  });

  observer.observe({ type: 'resource', buffered: true });

  return () => observer.disconnect();
}

export function getCacheStats(): CacheStats {
  return { ...stats };
}
```

### Logging Slow Asset Loads

```typescript
// lib/cache/slowAssetDetector.ts

/**
 * Detect assets that took too long to load (cache miss + slow network).
 */
export function detectSlowAssets(
  thresholdMs: number = 500,
  callback: (asset: { url: string; duration: number; size: number }) => void
): () => void {
  if (!('PerformanceObserver' in window)) return () => {};

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      if (entry.duration > thresholdMs && entry.transferSize > 0) {
        callback({
          url: entry.name,
          duration: Math.round(entry.duration),
          size: entry.transferSize,
        });
      }
    }
  });

  observer.observe({ type: 'resource', buffered: false });

  return () => observer.disconnect();
}
```
