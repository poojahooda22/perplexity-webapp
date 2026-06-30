# Bundle Optimization for WebGL Applications

> Three.js tree-shaking, bundle analysis, code splitting, dynamic imports, font subsetting, image optimization, compression, and target bundle sizes for production WebGL apps.

## Table of Contents

1. [Three.js Tree-Shaking](#threejs-tree-shaking)
2. [Bundle Analysis](#bundle-analysis)
3. [Code Splitting Strategies](#code-splitting-strategies)
4. [Dynamic Import for Heavy Shaders](#dynamic-import-for-heavy-shaders)
5. [Font Subsetting](#font-subsetting)
6. [Image Optimization](#image-optimization)
7. [Compression (gzip/Brotli)](#compression-gzipbrotli)
8. [Target Bundle Sizes](#target-bundle-sizes)
9. [Turbopack and Next.js Build Optimization](#turbopack-and-nextjs-build-optimization)
10. [Monitoring Bundle Size Over Time](#monitoring-bundle-size-over-time)

---

## Three.js Tree-Shaking

### The Problem

Three.js is approximately 1.2MB minified (600KB gzipped). A typical WebGL app uses
maybe 20-30% of its API surface. Without tree-shaking, you ship the entire library.

### Named Imports vs Namespace Import

```typescript
// BAD: Imports the entire Three.js library. No tree-shaking possible.
import * as THREE from 'three';
const geometry = new THREE.BoxGeometry();
const material = new THREE.MeshStandardMaterial();

// GOOD: Named imports allow the bundler to tree-shake unused exports.
import { BoxGeometry, MeshStandardMaterial } from 'three';
const geometry = new BoxGeometry();
const material = new MeshStandardMaterial();
```

### What CAN Be Tree-Shaken

Three.js r153+ has improved ESM support. These are tree-shakeable:
- Geometries (BoxGeometry, PlaneGeometry, SphereGeometry, etc.)
- Materials (MeshBasicMaterial, ShaderMaterial, etc.)
- Math utilities (Vector2, Vector3, Matrix4, etc.)
- Loaders (TextureLoader, GLTFLoader, etc.)
- Post-processing passes (from three/examples/jsm)
- Helper classes (ArrowHelper, GridHelper, etc.)

### What CANNOT Be Tree-Shaken

Some Three.js internals are side-effectful and cannot be eliminated:
- WebGLRenderer (pulls in most of the WebGL subsystem)
- Scene (core graph traversal)
- Camera classes (tied to projection internals)

### Three.js Import Map for Compositor Apps

```typescript
// lib/three-imports.ts
// Centralize Three.js imports to enforce tree-shakeable patterns.
// Other modules import from here, not from 'three' directly.

export {
  // Core
  Scene,
  WebGLRenderer,
  OrthographicCamera,
  PerspectiveCamera,

  // Geometry (only what we use)
  PlaneGeometry,
  BufferGeometry,
  BufferAttribute,

  // Materials
  ShaderMaterial,
  RawShaderMaterial,

  // Textures
  Texture,
  DataTexture,
  WebGLRenderTarget,

  // Math
  Vector2,
  Vector3,
  Vector4,
  Color,
  Matrix4,
  Quaternion,

  // Constants
  HalfFloatType,
  FloatType,
  UnsignedByteType,
  RGBAFormat,
  RedFormat,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  RepeatWrapping,
  NoBlending,
  NormalBlending,
  AdditiveBlending,
  SRGBColorSpace,
  LinearSRGBColorSpace,

  // Mesh
  Mesh,
  Object3D,
  Group,
} from 'three';

// Re-export types
export type {
  IUniform,
  WebGLRendererParameters,
  TextureDataType,
} from 'three';
```

### Webpack/Next.js Configuration for Three.js

```javascript
// next.config.mjs

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Ensure Three.js ESM is used (not CJS)
      config.resolve.alias = {
        ...config.resolve.alias,
        'three': 'three/src/Three.js', // Use source for best tree-shaking
      };

      // Avoid bundling Three.js examples twice
      // (once from three/examples/jsm, once from @react-three/drei)
      config.resolve.dedupe = ['three'];
    }

    return config;
  },

  // Enable experimental optimizations
  experimental: {
    optimizePackageImports: ['three', '@react-three/fiber', '@react-three/drei'],
  },
};

export default nextConfig;
```

### R3F Tree-Shaking

React Three Fiber itself is relatively small (~30KB gzipped), but `@react-three/drei`
is large because it re-exports many helpers.

```typescript
// BAD: Pulls in ALL of drei
import { OrbitControls, Html, Text } from '@react-three/drei';

// BETTER: Import from specific module paths (if supported by the package)
// Note: Not all packages support deep imports. Check package.json exports.
import { OrbitControls } from '@react-three/drei/core/OrbitControls';
```

In practice, `@react-three/drei` has barrel files that resist deep imports.
Use the Next.js `optimizePackageImports` config (shown above) to handle this.

---

## Bundle Analysis

### @next/bundle-analyzer

```bash
npm install --save-dev @next/bundle-analyzer
```

```javascript
// next.config.mjs

import withBundleAnalyzer from '@next/bundle-analyzer';

const analyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig = {
  // ... your config
};

export default analyzer(nextConfig);
```

```bash
# Run the analyzer
ANALYZE=true npm run build
# Opens two browser tabs: client bundles and server bundles
```

### What to Look For

```
Red Flags in Bundle Analysis:

1. Three.js appearing in multiple chunks
   -> Fix: Ensure dedupe in webpack config
   -> Check that three is not imported from different paths

2. Drei pulling in >100KB
   -> Fix: Use optimizePackageImports or import specific modules
   -> Check if you actually need drei (most compositor apps do not)

3. Duplicate polyfills
   -> Fix: Set browserslist to modern targets only
   -> WebGL2 already requires a modern browser

4. Large source maps in client bundles
   -> Fix: Use 'hidden-source-map' devtool
   -> Upload to Sentry, do not serve to users

5. Shader source code as large strings
   -> Fix: Use raw-loader with minification
   -> Or dynamic import shaders

6. Node.js polyfills (Buffer, process, crypto)
   -> Fix: Set resolve.fallback in webpack config
   -> Three.js does not need Node.js APIs
```

### Programmatic Size Tracking

```javascript
// scripts/check-bundle-size.mjs

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { gzipSync, brotliCompressSync } from 'zlib';

const BUILD_DIR = '.next/static/chunks';
const MAX_SIZES = {
  // Main app chunk
  'app/page': { gzip: 150_000, brotli: 120_000 },
  // Three.js chunk
  'three': { gzip: 350_000, brotli: 280_000 },
  // Total client JS
  total: { gzip: 500_000, brotli: 400_000 },
};

function getChunkSizes(dir) {
  const files = readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.js'));

  let totalRaw = 0;
  let totalGzip = 0;
  let totalBrotli = 0;

  const chunks = files.map((file) => {
    const path = join(dir, file);
    const content = readFileSync(path);
    const raw = content.length;
    const gzip = gzipSync(content).length;
    const brotli = brotliCompressSync(content).length;

    totalRaw += raw;
    totalGzip += gzip;
    totalBrotli += brotli;

    return {
      file,
      raw: formatBytes(raw),
      gzip: formatBytes(gzip),
      brotli: formatBytes(brotli),
      gzipBytes: gzip,
      brotliBytes: brotli,
    };
  });

  return {
    chunks: chunks.sort((a, b) => b.gzipBytes - a.gzipBytes),
    total: { raw: totalRaw, gzip: totalGzip, brotli: totalBrotli },
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Run analysis
const sizes = getChunkSizes(BUILD_DIR);

console.log('\nBundle Size Report');
console.log('==================');
console.log(`Total: ${formatBytes(sizes.total.raw)} raw, ${formatBytes(sizes.total.gzip)} gzip, ${formatBytes(sizes.total.brotli)} brotli\n`);

console.log('Top 10 chunks:');
for (const chunk of sizes.chunks.slice(0, 10)) {
  console.log(`  ${chunk.gzip.padStart(10)} gzip  ${chunk.brotli.padStart(10)} brotli  ${chunk.file}`);
}

// Budget check
if (sizes.total.gzip > MAX_SIZES.total.gzip) {
  console.error(`\nBUDGET EXCEEDED: Total gzip ${formatBytes(sizes.total.gzip)} > ${formatBytes(MAX_SIZES.total.gzip)}`);
  process.exit(1);
}

console.log('\nAll budgets passed.');
```

---

## Code Splitting Strategies

### Lazy Load Property Panel

The property panel (sliders, color pickers, etc.) is not needed until the user
opens it. Lazy load it.

```tsx
// app/editor/layout.tsx

import dynamic from 'next/dynamic';

// Lazy load the property panel
const PropertyPanel = dynamic(
  () => import('@/components/editor/PropertyPanel'),
  {
    loading: () => <div className="property-panel-skeleton" />,
    ssr: false, // No SSR for editor components
  }
);

// Lazy load the layer list
const LayerList = dynamic(
  () => import('@/components/editor/LayerList'),
  {
    loading: () => <div className="layer-list-skeleton" />,
    ssr: false,
  }
);

export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="editor-layout">
      <LayerList />
      <main>{children}</main>
      <PropertyPanel />
    </div>
  );
}
```

### Lazy Load Primitives by Type

Not all effect types are needed upfront. Load them on demand.

```typescript
// lib/primitives/lazyPrimitives.ts

type PrimitiveModule = {
  default: PrimitiveDefinition;
};

const primitiveLoaders: Record<string, () => Promise<PrimitiveModule>> = {
  bloom: () => import('./definitions/bloom'),
  blur: () => import('./definitions/blur'),
  fog: () => import('./definitions/fog'),
  grain: () => import('./definitions/grain'),
  vignette: () => import('./definitions/vignette'),
  chromaticAberration: () => import('./definitions/chromaticAberration'),
  colorGrading: () => import('./definitions/colorGrading'),
  glitch: () => import('./definitions/glitch'),
  pixelate: () => import('./definitions/pixelate'),
  waterRipple: () => import('./definitions/waterRipple'),
  blobTracking: () => import('./definitions/blobTracking'),
  progressiveBlur: () => import('./definitions/progressiveBlur'),
  radialBlur: () => import('./definitions/radialBlur'),
  zoomBlur: () => import('./definitions/zoomBlur'),
};

// Cache loaded primitives
const cache = new Map<string, PrimitiveDefinition>();

/**
 * Load a primitive definition on demand.
 * First call for a type triggers a dynamic import.
 * Subsequent calls return from cache.
 */
export async function loadPrimitive(type: string): Promise<PrimitiveDefinition> {
  const cached = cache.get(type);
  if (cached) return cached;

  const loader = primitiveLoaders[type];
  if (!loader) {
    throw new Error(`Unknown primitive type: ${type}`);
  }

  const module = await loader();
  cache.set(type, module.default);
  return module.default;
}

/**
 * Preload commonly used primitives.
 * Call this during the loading screen to avoid delays later.
 */
export async function preloadCommonPrimitives(): Promise<void> {
  const common = ['bloom', 'blur', 'vignette', 'grain'];
  await Promise.all(common.map(loadPrimitive));
}
```

### Lazy Load Material Classes

Material classes (ShaderMaterial subclasses) can be heavy because they contain
GLSL shader strings. Split them into separate chunks.

```typescript
// lib/r3f-compositor/materials/lazyMaterials.ts

type MaterialConstructor = new (...args: any[]) => THREE.ShaderMaterial;

const materialLoaders: Record<string, () => Promise<{ default: MaterialConstructor }>> = {
  bloom: () => import('./BloomMaterial'),
  fastBloom: () => import('./FastBloomMaterial'),
  blur: () => import('./BlurMaterial'),
  fog: () => import('./FogMaterial'),
  blobTracking: () => import('./BlobTrackingMaterial'),
  progressiveBlur: () => import('./ProgressiveBlurMaterial'),
  radialBlur: () => import('./RadialBlurMaterial'),
  zoomBlur: () => import('./ZoomBlurMaterial'),
};

const materialCache = new Map<string, MaterialConstructor>();

export async function getMaterialClass(type: string): Promise<MaterialConstructor> {
  const cached = materialCache.get(type);
  if (cached) return cached;

  const loader = materialLoaders[type];
  if (!loader) {
    throw new Error(`Unknown material type: ${type}`);
  }

  const module = await loader();
  materialCache.set(type, module.default);
  return module.default;
}
```

### Route-Level Code Splitting

```
app/
  page.tsx              -> Landing page (no Three.js)
  editor/
    page.tsx            -> Editor (Three.js loaded here)
    loading.tsx         -> Skeleton while editor loads
  docs/
    page.tsx            -> Documentation (no Three.js)
  api/
    ...                 -> API routes (no Three.js)
```

Three.js should ONLY be in the editor route's chunk. Verify with bundle analyzer
that the landing page and docs pages have zero Three.js code.

---

## Dynamic Import for Heavy Shaders

### Shader Source as Separate Chunks

GLSL shader strings can be large (5-50KB per effect when including all passes).
Use webpack raw-loader with dynamic import.

```typescript
// lib/shaders/loadShader.ts

const shaderCache = new Map<string, string>();

/**
 * Dynamically import a GLSL shader source file.
 * Webpack will create a separate chunk for each shader.
 */
export async function loadShader(name: string): Promise<string> {
  const cached = shaderCache.get(name);
  if (cached) return cached;

  // Dynamic import with webpack magic comments
  let source: string;

  switch (name) {
    case 'bloom.frag':
      source = (await import(
        /* webpackChunkName: "shader-bloom" */
        '../shaders/bloom.frag?raw'
      )).default;
      break;
    case 'blur.frag':
      source = (await import(
        /* webpackChunkName: "shader-blur" */
        '../shaders/blur.frag?raw'
      )).default;
      break;
    // ... etc
    default:
      throw new Error(`Unknown shader: ${name}`);
  }

  shaderCache.set(name, source);
  return source;
}
```

### Inline Small Shaders, Import Large Ones

```
Rule of thumb:
- Shaders < 2KB: Inline in the material file (template literal)
- Shaders 2-10KB: Import as raw string (static import, same chunk)
- Shaders > 10KB: Dynamic import (separate chunk)

Most compositor effects have shaders < 5KB. Inline them.
Complex effects (bloom with 6 passes, volumetric fog) may exceed 10KB.
```

---

## Font Subsetting

### Problem

Custom fonts for the editor UI can add 100-500KB per weight/style.
Subsetting removes unused glyphs.

### Subsetting with glyphhanger

```bash
# Install
npm install -g glyphhanger

# Analyze which characters your app uses
glyphhanger http://localhost:3000/editor --spider --spider-limit=5

# Subset the font to only used characters
glyphhanger --whitelist="US_ASCII" --subset=fonts/Inter-Regular.woff2
# Output: fonts/Inter-Regular-subset.woff2 (~20KB instead of ~100KB)
```

### Next.js Font Optimization

```tsx
// app/layout.tsx

import { Inter } from 'next/font/google';

// next/font automatically subsets, self-hosts, and optimizes
const inter = Inter({
  subsets: ['latin'],
  display: 'swap', // Show fallback font while loading
  variable: '--font-inter',
  // Only load the weights you actually use
  weight: ['400', '500', '600'],
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
```

### Monospace Font for Code/Shader Display

```tsx
// Only load mono font on the editor page, not globally

import { JetBrains_Mono } from 'next/font/google';

const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  weight: ['400'],
});
```

---

## Image Optimization

### Next.js Image Component

```tsx
// Use next/image for all raster images
import Image from 'next/image';

// Automatically optimized: WebP/AVIF, responsive sizes, lazy loading
<Image
  src="/textures/noise-256.png"
  width={256}
  height={256}
  alt="Noise texture"
  priority={false} // Lazy load by default
/>
```

### Texture Image Optimization

For WebGL textures (noise maps, LUTs), the standard rules differ:

```
Standard Web Images:
- Use WebP/AVIF (lossy is fine)
- Use responsive sizes
- Lazy load below the fold

WebGL Textures:
- Use PNG (lossless, exact pixel values matter for shader math)
- Do NOT use WebP/AVIF (lossy compression corrupts gradient data)
- Use power-of-two dimensions (256, 512, 1024)
- Pre-generate mipmaps offline if needed
- Consider KTX2/Basis compressed textures for large textures
```

### KTX2 Compressed Textures

For large textures (environment maps, HDRIs), use GPU-compressed formats:

```typescript
// KTX2 textures are compressed ON the GPU, saving both download and VRAM
// Requires basis_transcoder.wasm

import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

const ktx2Loader = new KTX2Loader()
  .setTranscoderPath('/libs/basis/')
  .detectSupport(renderer);

// Load a GPU-compressed texture
const texture = await ktx2Loader.loadAsync('/textures/envmap.ktx2');
// Compressed: ~200KB instead of ~2MB for a 1024x1024 RGBA texture
```

### SVG for UI Icons

```
Do:    Use SVGs for editor icons (layer icons, tool icons, etc.)
Do:    Inline small SVGs as React components (< 1KB)
Do:    Use sprite sheets for many icons (> 20)
Don't: Use icon fonts (heavy, not tree-shakeable)
Don't: Use PNG/JPG for icons (not scalable, larger at high DPI)
```

---

## Compression (gzip/Brotli)

### Vercel Automatic Compression

Vercel automatically serves static assets with Brotli compression (with gzip fallback).
No configuration needed. This applies to:
- JavaScript bundles
- CSS files
- HTML pages
- JSON files

### Compression Ratios for WebGL Assets

```
File Type              Raw Size    gzip      Brotli    Notes
---                    ---         ---       ---       ---
Three.js (minified)    ~1.2 MB     ~350 KB   ~280 KB   Highly compressible text
GLSL shaders           ~50 KB      ~8 KB     ~6 KB     Repetitive syntax
JSON primitives        ~20 KB      ~3 KB     ~2 KB     Highly compressible
CSS (Tailwind purged)  ~30 KB      ~6 KB     ~5 KB     Good compression
PNG textures           ~100 KB     ~98 KB    ~97 KB    Already compressed, skip
KTX2 textures          ~200 KB     ~195 KB   ~193 KB   Already compressed, skip
WASM (basis)           ~200 KB     ~100 KB   ~80 KB    Moderate compression
```

### Custom Compression for API Responses

```typescript
// app/api/primitives/[type]/route.ts

import { NextResponse } from 'next/server';

export async function GET(
  request: Request,
  { params }: { params: { type: string } }
) {
  const primitive = await loadPrimitive(params.type);

  // Vercel handles compression automatically for NextResponse
  return NextResponse.json(primitive, {
    headers: {
      // Cache immutable primitive definitions aggressively
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
```

---

## Target Bundle Sizes

### Budget Table

```
Category               Target (gzip)    Target (brotli)    Hard Limit
---                    ---              ---                ---
Core framework         80 KB            65 KB              120 KB
(React + Next.js runtime)

Three.js               250 KB           200 KB             400 KB
(tree-shaken)

R3F + integrations     40 KB            30 KB              60 KB
(@react-three/fiber)

Editor UI              60 KB            50 KB              100 KB
(panels, controls)

Shader sources         15 KB            10 KB              30 KB
(all GLSL combined)

Primitive definitions  10 KB            8 KB               20 KB
(JSON configs)

State management       15 KB            12 KB              25 KB
(Zustand + middleware)

Utilities              20 KB            15 KB              30 KB
(helpers, formatters)

---                    ---              ---                ---
TOTAL                  490 KB           390 KB             785 KB
```

### Budget Enforcement in CI

```yaml
# .github/workflows/bundle-check.yml

name: Bundle Size Check
on: [pull_request]

jobs:
  check-bundle:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - name: Check bundle sizes
        run: node scripts/check-bundle-size.mjs
```

```json
// package.json
{
  "scripts": {
    "analyze": "ANALYZE=true next build",
    "check-bundle": "next build && node scripts/check-bundle-size.mjs"
  }
}
```

---

## Turbopack and Next.js Build Optimization

### Turbopack Configuration

```javascript
// next.config.mjs

const nextConfig = {
  // Turbopack for development (much faster than webpack)
  // Note: Turbopack is the default in Next.js 15+ for dev
  // For production builds, webpack is still used

  experimental: {
    // Optimize package imports for Three.js ecosystem
    optimizePackageImports: [
      'three',
      '@react-three/fiber',
      '@react-three/drei',
    ],
  },

  // Reduce build time by excluding large packages from server compilation
  serverExternalPackages: ['three'],

  // Optimize images at build time
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 31536000, // 1 year
  },
};
```

### Build Time Analysis

```bash
# Measure build time
time npm run build

# Next.js outputs build details
# Look for:
# - "Compiling..." time
# - "Collecting page data..." time
# - "Generating static pages..." time
# - Bundle sizes per route

# If build is slow, check:
# 1. Are you importing Three.js in server components? (should be client-only)
# 2. Is the ANALYZE flag accidentally on?
# 3. Are source maps being generated? (needed for Sentry but slows build)
```

### Client-Only Boundary

```tsx
// Ensure Three.js and R3F never end up in server-side code

// components/editor/Canvas.tsx
'use client'; // CRITICAL: This directive keeps Three.js out of the server bundle

import { Canvas } from '@react-three/fiber';
// ... rest of component
```

---

## Monitoring Bundle Size Over Time

### Size Limit

```bash
npm install --save-dev size-limit @size-limit/preset-app
```

```json
// package.json
{
  "size-limit": [
    {
      "name": "Total Client JS",
      "path": ".next/static/chunks/**/*.js",
      "limit": "500 KB",
      "gzip": true
    },
    {
      "name": "Three.js Chunk",
      "path": ".next/static/chunks/*three*.js",
      "limit": "350 KB",
      "gzip": true
    }
  ],
  "scripts": {
    "size": "size-limit",
    "size-report": "size-limit --json > bundle-report.json"
  }
}
```

### PR Comment Bot

```yaml
# .github/workflows/size-limit.yml

name: Bundle Size
on: [pull_request]

jobs:
  size:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: andresz1/size-limit-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Posts a comment on the PR with size delta
```

### Historical Size Tracking

```typescript
// scripts/record-bundle-size.mjs
// Run after every merge to main. Store in a JSON file or database.

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const HISTORY_FILE = 'bundle-size-history.json';

function getCurrentSizes() {
  // Get the sizes from size-limit
  const output = execSync('npx size-limit --json', { encoding: 'utf-8' });
  return JSON.parse(output);
}

function recordSize() {
  const current = getCurrentSizes();
  const commit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  const date = new Date().toISOString();

  const history = existsSync(HISTORY_FILE)
    ? JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
    : [];

  history.push({
    commit,
    date,
    sizes: current,
  });

  // Keep last 100 entries
  const trimmed = history.slice(-100);
  writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

recordSize();
```

### Quick Wins Checklist

```
Action                                  Typical Savings
---                                     ---
Tree-shake Three.js (named imports)     200-400 KB gzip
Remove unused drei helpers              50-100 KB gzip
Lazy load property panel                30-50 KB gzip
Lazy load heavy effects (bloom, fog)    10-20 KB gzip
Font subsetting                         50-100 KB
Remove moment.js / date-fns if unused   20-60 KB gzip
Use CSS instead of icon fonts           30-50 KB
Enable Brotli (Vercel default)          10-20% better than gzip
Dedupe Three.js in node_modules         100-300 KB gzip (if duplicated)
```
