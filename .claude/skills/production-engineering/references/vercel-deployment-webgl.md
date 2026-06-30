# Vercel Deployment for WebGL Applications

> Next.js build optimization for Three.js, preview deployments, build time analysis, edge caching for static assets, vercel.json configuration, custom error pages, and production deployment patterns for WebGL apps.

## Table of Contents

1. [Next.js Build Optimization for Three.js](#nextjs-build-optimization-for-threejs)
2. [Preview Deployments for GPU Testing](#preview-deployments-for-gpu-testing)
3. [Environment Variables](#environment-variables)
4. [Build Time Analysis and Optimization](#build-time-analysis-and-optimization)
5. [Edge Caching for Static Assets](#edge-caching-for-static-assets)
6. [vercel.json Configuration](#verceljson-configuration)
7. [Custom Error Pages](#custom-error-pages)
8. [Domain Setup and SSL](#domain-setup-and-ssl)
9. [Deployment Pipeline](#deployment-pipeline)
10. [Production Checklist](#production-checklist)

---

## Next.js Build Optimization for Three.js

### next.config.mjs for WebGL Projects

```javascript
// next.config.mjs

/** @type {import('next').NextConfig} */
const nextConfig = {
  // React strict mode helps catch dispose issues during development
  reactStrictMode: true,

  // Optimize Three.js and R3F imports for tree-shaking
  experimental: {
    optimizePackageImports: [
      'three',
      '@react-three/fiber',
      '@react-three/drei',
    ],
  },

  // Three.js should never be loaded on the server
  // It depends on browser APIs (canvas, WebGL, DOM)
  serverExternalPackages: ['three'],

  // Source maps for Sentry (uploaded then deleted)
  productionBrowserSourceMaps: false, // Sentry plugin handles this

  webpack: (config, { isServer, dev }) => {
    if (!isServer) {
      // Deduplicate Three.js to prevent multiple copies in bundle
      config.resolve.dedupe = [
        'three',
        '@react-three/fiber',
      ];

      // GLSL shader file support
      config.module.rules.push({
        test: /\.(glsl|vert|frag|vs|fs)$/,
        type: 'asset/source',
      });

      // Ensure no Node.js polyfills are included
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
      };
    }

    // Production-only optimizations
    if (!dev && !isServer) {
      // Split Three.js into its own chunk for better caching
      config.optimization.splitChunks = {
        ...config.optimization.splitChunks,
        cacheGroups: {
          ...config.optimization.splitChunks?.cacheGroups,
          three: {
            test: /[\\/]node_modules[\\/](three|@react-three)[\\/]/,
            name: 'three-vendor',
            chunks: 'all',
            priority: 20,
          },
        },
      };
    }

    return config;
  },

  // Image optimization settings
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 31536000,
    // Do NOT optimize WebGL textures through next/image
    // They need exact pixel values (lossless)
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
    ],
  },

  // Headers are defined in vercel.json for production
  // but we can set defaults here for development
  async headers() {
    return [
      {
        source: '/textures/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/shaders/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

export default nextConfig;
```

### Client-Only Boundary Pattern

Three.js MUST NOT be imported in server components. Enforce this with the
`'use client'` directive.

```tsx
// components/editor/EditorCanvas.tsx
'use client';

// These imports are now guaranteed to be client-only
import { Canvas } from '@react-three/fiber';
import { OrthographicCamera } from 'three';

export function EditorCanvas() {
  return (
    <Canvas
      gl={{
        powerPreference: 'high-performance',
        antialias: false,
        alpha: false,
        stencil: false,
        depth: true,
      }}
      frameloop="always"
    >
      <CompositorScene />
    </Canvas>
  );
}
```

### Dynamic Import for the Editor

```tsx
// app/editor/page.tsx

import dynamic from 'next/dynamic';

// Dynamically import the entire editor to keep the landing page lightweight
const Editor = dynamic(() => import('@/components/editor/Editor'), {
  ssr: false, // Never render on server (needs WebGL)
  loading: () => <EditorSkeleton />,
});

export default function EditorPage() {
  return <Editor />;
}

function EditorSkeleton() {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      backgroundColor: '#111',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#444',
    }}>
      Loading editor...
    </div>
  );
}
```

---

## Preview Deployments for GPU Testing

### How Preview Deployments Help

Every PR gets a unique URL (e.g., `your-app-git-feature-bloom-v2.vercel.app`).
This enables:
- Testing GPU features on different devices without deploying to production
- Sharing preview links with testers who have specific GPUs
- Visual regression testing across browsers

### Testing Matrix for GPU Features

```
Browser            GPU Tier    Priority    Test On
---                ---         ---         ---
Chrome latest      NVIDIA      HIGH        Developer machine
Chrome latest      AMD         HIGH        Test machine or cloud
Chrome latest      Intel       HIGH        Laptop (common for users)
Chrome latest      Apple M1+   HIGH        MacBook
Firefox latest     Any         MEDIUM      Developer machine
Safari latest      Apple       HIGH        MacBook
Edge latest        Any         LOW         Windows machine
Chrome Android     Adreno      MEDIUM      Physical device or BrowserStack
Safari iOS         Apple       MEDIUM      Physical device or BrowserStack
```

### PR Comment with Preview URL and Test Checklist

```yaml
# .github/workflows/preview-test.yml

name: Preview Deployment Test
on:
  deployment_status:

jobs:
  test-preview:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Comment test checklist on PR
        uses: actions/github-script@v7
        with:
          script: |
            const url = context.payload.deployment_status.target_url;
            const body = `## Preview Deployment Ready

            **URL:** ${url}

            ### GPU Testing Checklist
            - [ ] Canvas renders (not black screen)
            - [ ] Add Bloom effect -- verify glow is visible
            - [ ] Add Blur effect -- verify blur is smooth
            - [ ] Add 5+ layers -- verify no frame drop below 30fps
            - [ ] Resize window -- verify no artifacts
            - [ ] Test on mobile (if applicable)

            ### Quick Test Link
            Open directly: [${url}/editor](${url}/editor)
            `;

            // Find the PR associated with this deployment
            const prs = await github.rest.pulls.list({
              owner: context.repo.owner,
              repo: context.repo.repo,
              state: 'open',
              head: `${context.repo.owner}:${context.payload.deployment.ref}`,
            });

            if (prs.data.length > 0) {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: prs.data[0].number,
                body,
              });
            }
```

### Playwright Tests Against Preview Deployments

```typescript
// e2e/preview-gpu.spec.ts

import { test, expect } from '@playwright/test';

const PREVIEW_URL = process.env.PREVIEW_URL || 'http://localhost:3000';

test.describe('GPU Feature Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${PREVIEW_URL}/editor`);
    await page.waitForSelector('canvas', { timeout: 10000 });
    // Wait for first render
    await page.waitForTimeout(1000);
  });

  test('canvas renders non-black content', async ({ page }) => {
    const isRendering = await page.evaluate(() => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      if (!canvas) return false;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        // WebGL canvas -- check via ImageData
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d')!;
        tempCtx.drawImage(canvas, 0, 0);
        const data = tempCtx.getImageData(0, 0, canvas.width, canvas.height).data;

        // Check if at least some pixels are non-zero
        let nonZero = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) {
            nonZero++;
          }
        }
        return nonZero > 100; // At least 100 non-black pixels
      }
      return false;
    });

    expect(isRendering).toBe(true);
  });

  test('WebGL context is active', async ({ page }) => {
    const contextOk = await page.evaluate(() => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      if (!canvas) return false;
      const gl = canvas.getContext('webgl2');
      return gl ? !gl.isContextLost() : false;
    });

    expect(contextOk).toBe(true);
  });
});
```

---

## Environment Variables

### WebGL Apps Are Mostly Client-Side

Pure client-side WebGL apps typically need very few environment variables.
All GPU computation happens in the browser. Common variables:

```bash
# .env.local (development only, not committed)

# Analytics and error tracking
NEXT_PUBLIC_SENTRY_DSN=https://xxx@sentry.io/xxx
NEXT_PUBLIC_VERCEL_ANALYTICS_ID=xxx

# Feature flags (optional)
NEXT_PUBLIC_ENABLE_DEBUG_HUD=true
NEXT_PUBLIC_MAX_LAYERS=50

# Build-time only (not exposed to client)
SENTRY_AUTH_TOKEN=sntrys_xxx
SENTRY_ORG=your-org
SENTRY_PROJECT=your-project
```

### Important: NEXT_PUBLIC_ Prefix

```
Variables with NEXT_PUBLIC_ prefix:
  - Embedded in the client JS bundle at BUILD TIME
  - Visible to anyone who inspects the page source
  - Cannot contain secrets
  - Use for: analytics IDs, feature flags, public API URLs

Variables WITHOUT NEXT_PUBLIC_ prefix:
  - Only available in server-side code (API routes, getServerSideProps)
  - Never sent to the browser
  - Use for: API keys, database URLs, Sentry auth tokens
```

### Vercel Environment Variables

```bash
# Set production environment variables on Vercel
vercel env add SENTRY_AUTH_TOKEN production
vercel env add NEXT_PUBLIC_SENTRY_DSN production

# Pull environment variables to .env.local for development
vercel env pull .env.local
```

---

## Build Time Analysis and Optimization

### Measuring Build Time

```bash
# Basic build time measurement
time npm run build

# Verbose build output
NEXT_PRIVATE_DEBUG_BUILD=1 npm run build

# Turbopack trace (for development builds)
NEXT_TURBOPACK_TRACING=1 npm run dev
```

### Common Build Time Issues for WebGL Projects

```
Issue                           Symptom              Fix
---                             ---                  ---
Three.js SSR compilation        Build > 60s          Mark 'use client', serverExternalPackages
Shader files parsed as JS       Warnings in build    Add GLSL loader to webpack config
Sentry source map upload        Build + 30-60s       Ensure SENTRY_AUTH_TOKEN is set
                                                     (otherwise upload retries and times out)
Large static pages              Build > 120s         Use dynamic imports for editor
Unused dependencies             Large node_modules   Audit with `npx depcheck`
TypeScript strict mode          Slow type checking    Use `ignoreBuildErrors` only as last resort
```

### Build Output Analysis

```bash
# After `npm run build`, Next.js outputs:

Route (app)                    Size     First Load JS
---                            ---      ---
/                              5 kB     90 kB          # Landing page (no Three.js)
/editor                        2 kB     85 kB          # Editor shell (lazy loads canvas)
/_not-found                    1 kB     85 kB

+ First Load JS shared by all  85 kB

# The "First Load JS" for /editor should NOT include Three.js
# Three.js should be in a lazy-loaded chunk that arrives AFTER the page shell

# Check with bundle analyzer:
ANALYZE=true npm run build
```

### Optimizing Build for CI

```yaml
# .github/workflows/build.yml

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      # Cache Next.js build cache
      - uses: actions/cache@v4
        with:
          path: .next/cache
          key: nextjs-${{ hashFiles('package-lock.json') }}-${{ hashFiles('**/*.ts', '**/*.tsx') }}
          restore-keys: |
            nextjs-${{ hashFiles('package-lock.json') }}-

      - run: npm ci
      - run: npm run build

      # Verify no Three.js in server bundle
      - name: Check server bundle
        run: |
          if grep -r "three" .next/server/chunks/ 2>/dev/null; then
            echo "WARNING: Three.js found in server bundle!"
            exit 1
          fi
```

---

## Edge Caching for Static Assets

### Next.js Static Asset Caching

Next.js automatically sets correct cache headers for assets in `/_next/static/`:
- Content-hashed filenames
- `Cache-Control: public, max-age=31536000, immutable`
- Served from Vercel's edge network

No configuration needed for these.

### Custom Static Asset Caching

For assets in `/public/` (textures, shaders, WASM), you need explicit headers:

```json
// vercel.json
{
  "headers": [
    {
      "source": "/textures/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" },
        { "key": "Access-Control-Allow-Origin", "value": "*" }
      ]
    },
    {
      "source": "/shaders/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/libs/(.*\\.wasm)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" },
        { "key": "Content-Type", "value": "application/wasm" }
      ]
    }
  ]
}
```

### Preloading Critical Assets

```tsx
// app/editor/layout.tsx

export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Preload the Three.js vendor chunk */}
      <link
        rel="modulepreload"
        href="/_next/static/chunks/three-vendor-HASH.js"
      />
      {children}
    </>
  );
}
```

Note: The hash in the filename changes per build. In practice, use the
Next.js `<Script strategy="beforeInteractive">` pattern or let the framework
handle preloading automatically.

---

## vercel.json Configuration

### Complete vercel.json for WebGL Apps

```json
{
  "framework": "nextjs",

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
          "value": "SAMEORIGIN"
        },
        {
          "key": "X-XSS-Protection",
          "value": "1; mode=block"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        },
        {
          "key": "Permissions-Policy",
          "value": "camera=(), microphone=(), geolocation=()"
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
    },
    {
      "source": "/textures/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        },
        {
          "key": "Access-Control-Allow-Origin",
          "value": "*"
        }
      ]
    },
    {
      "source": "/shaders/(.*)",
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
    },
    {
      "source": "/primitives/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    },
    {
      "source": "/libs/(.*\\.wasm)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        },
        {
          "key": "Content-Type",
          "value": "application/wasm"
        }
      ]
    },
    {
      "source": "/sw.js",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "no-cache, no-store, must-revalidate"
        },
        {
          "key": "Service-Worker-Allowed",
          "value": "/"
        }
      ]
    }
  ],

  "redirects": [
    {
      "source": "/app",
      "destination": "/editor",
      "permanent": true
    }
  ],

  "rewrites": []
}
```

### Security Headers for WebGL

```
Header                     Value                           Purpose
---                        ---                             ---
X-Content-Type-Options     nosniff                         Prevent MIME sniffing
X-Frame-Options            SAMEORIGIN                      Allow embedding in own domain only
X-XSS-Protection           1; mode=block                   XSS protection (legacy browsers)
Referrer-Policy            strict-origin-when-cross-origin  Limit referer leakage
Permissions-Policy         camera=(), microphone=()        Disable unused browser APIs

NOT recommended for WebGL apps:
Content-Security-Policy    script-src 'self'               Breaks inline scripts, eval()
                                                           Three.js uses eval in some paths
                                                           Add carefully with testing
```

---

## Custom Error Pages

### 404 Page

```tsx
// app/not-found.tsx

export default function NotFound() {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#0a0a0a',
      color: '#e0e0e0',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <h1 style={{ fontSize: '6rem', margin: 0, color: '#333' }}>404</h1>
      <p style={{ color: '#666', marginTop: '1rem' }}>
        This page does not exist.
      </p>
      <a
        href="/"
        style={{
          marginTop: '2rem',
          padding: '0.75rem 1.5rem',
          backgroundColor: '#4a9eff',
          color: 'white',
          textDecoration: 'none',
          borderRadius: '6px',
        }}
      >
        Go Home
      </a>
    </div>
  );
}
```

### Error Page

```tsx
// app/error.tsx
'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report to Sentry
    import('@sentry/nextjs').then((Sentry) => {
      Sentry.captureException(error);
    });
  }, [error]);

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#0a0a0a',
      color: '#e0e0e0',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }}>
        Something went wrong
      </h2>
      <p style={{ color: '#666', maxWidth: '400px', textAlign: 'center' }}>
        An unexpected error occurred. Your work has been auto-saved.
      </p>
      {error.digest && (
        <p style={{ color: '#444', fontSize: '0.8rem', marginTop: '0.5rem' }}>
          Error ID: {error.digest}
        </p>
      )}
      <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem' }}>
        <button
          onClick={reset}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#4a9eff',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          Try Again
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#333',
            color: 'white',
            border: '1px solid #555',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          Reload Page
        </button>
      </div>
    </div>
  );
}
```

### Global Error Page (Catches Root Layout Errors)

```tsx
// app/global-error.tsx
'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body style={{
        margin: 0,
        backgroundColor: '#0a0a0a',
        color: '#e0e0e0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'system-ui',
      }}>
        <div style={{ textAlign: 'center' }}>
          <h2>Critical Error</h2>
          <p>The application failed to load. Please try refreshing.</p>
          <button
            onClick={reset}
            style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: '#4a9eff',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              marginTop: '1rem',
            }}
          >
            Refresh
          </button>
        </div>
      </body>
    </html>
  );
}
```

---

## Domain Setup and SSL

### Vercel Domain Configuration

```bash
# Add a custom domain
vercel domains add app.example.com

# Verify DNS is configured
vercel domains inspect app.example.com

# SSL is automatic with Vercel
# Both the apex domain and www subdomain are supported
```

### DNS Configuration

```
Type    Name    Value                       TTL
---     ---     ---                         ---
CNAME   app     cname.vercel-dns.com.       300
A       @       76.76.21.21                 300
AAAA    @       2606:4700:4400::6812:264e   300
```

### Redirect www to non-www (or vice versa)

```json
// vercel.json
{
  "redirects": [
    {
      "source": "/(.*)",
      "has": [{ "type": "host", "value": "www.example.com" }],
      "destination": "https://example.com/$1",
      "permanent": true
    }
  ]
}
```

---

## Deployment Pipeline

### Recommended Git Flow

```
main (production)
  |
  +-- feature/bloom-v2 (development)
  |     |
  |     +-- PR -> Preview deployment (auto)
  |     +-- Tests pass
  |     +-- Visual review on preview URL
  |     +-- Merge to main -> Production deployment (auto)
  |
  +-- fix/context-loss-recovery (hotfix)
        |
        +-- PR -> Preview deployment (auto)
        +-- Merge to main -> Production deployment (auto)
```

### Vercel CLI for Manual Deployments

```bash
# Deploy to preview (for testing)
vercel

# Deploy to production
vercel --prod

# Deploy with specific environment
vercel --env NODE_ENV=production

# Check deployment status
vercel ls

# View logs for a deployment
vercel logs https://your-app-xxx.vercel.app
```

### GitHub Actions Integration

```yaml
# .github/workflows/ci.yml

name: CI
on: [push, pull_request]

jobs:
  lint-and-type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run type-check

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm test

  build:
    runs-on: ubuntu-latest
    needs: [lint-and-type-check, test]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - uses: actions/cache@v4
        with:
          path: .next/cache
          key: nextjs-${{ hashFiles('package-lock.json') }}
      - run: npm ci
      - run: npm run build
      - name: Check bundle size
        run: node scripts/check-bundle-size.mjs

  # Vercel handles deployment automatically via GitHub integration
  # This workflow only runs CI checks
```

---

## Production Checklist

### Pre-Deployment Checklist

```
Build and Bundle:
  [ ] Build completes without errors
  [ ] Build completes without warnings (or warnings are known/acceptable)
  [ ] Bundle size is within budget (< 500KB gzip total)
  [ ] Three.js is tree-shaken (check with bundle analyzer)
  [ ] Three.js is NOT in server bundles
  [ ] Source maps uploaded to Sentry
  [ ] Source maps NOT served to users

Performance:
  [ ] FPS > 60 on high-end GPU
  [ ] FPS > 30 on mid-range GPU
  [ ] LCP < 2.5s
  [ ] INP < 200ms
  [ ] CLS < 0.1
  [ ] No memory leaks (add/remove layer test)

WebGL:
  [ ] Works on Chrome, Firefox, Safari
  [ ] Works on Windows, macOS
  [ ] Graceful fallback for no WebGL2
  [ ] Context loss recovery works
  [ ] No shader compilation errors on Intel GPUs
  [ ] No visual artifacts at different DPR values

Caching:
  [ ] Static assets have immutable cache headers
  [ ] API responses have appropriate cache headers
  [ ] Content-hashed filenames for all static assets
  [ ] CORS headers on texture endpoints

Error Handling:
  [ ] Error boundaries catch React errors
  [ ] Context loss shows recovery UI
  [ ] Shader errors are logged to Sentry
  [ ] 404 page renders correctly
  [ ] Error page renders correctly

Security:
  [ ] No secrets in NEXT_PUBLIC_ variables
  [ ] Security headers in vercel.json
  [ ] CORS restricted to known origins (for API routes)
  [ ] No console.log in production (or filtered)

Monitoring:
  [ ] Sentry configured with GPU context
  [ ] Custom breadcrumbs for editor actions
  [ ] FPS monitoring enabled (sampled)
  [ ] Memory monitoring enabled (sampled)
  [ ] Vercel Analytics / Speed Insights enabled

Infrastructure:
  [ ] Custom domain configured
  [ ] SSL active (automatic on Vercel)
  [ ] Redirects configured (www -> non-www)
  [ ] Environment variables set on Vercel
```

### Post-Deployment Verification

```bash
# 1. Check the deployment is live
curl -I https://example.com

# 2. Check cache headers
curl -I https://example.com/_next/static/chunks/main-HASH.js
# Expect: cache-control: public, max-age=31536000, immutable

# 3. Check WebGL headers
curl -I https://example.com/textures/noise.png
# Expect: access-control-allow-origin: *
# Expect: cache-control: public, max-age=31536000, immutable

# 4. Check for errors in Sentry
# Open Sentry dashboard, filter by release

# 5. Check Vercel Analytics for anomalies
# Open Vercel dashboard > Analytics

# 6. Manual smoke test
# Open /editor in Chrome, Firefox, Safari
# Add an effect, verify it renders
# Check FPS HUD (if available)
```

### Rollback Procedure

```bash
# If a bad deployment goes out:

# 1. Instant rollback to previous deployment
vercel rollback

# 2. Or promote a specific previous deployment
vercel promote <deployment-url>

# 3. Verify rollback
curl -I https://example.com
# Check x-vercel-deployment-url header matches the rolled-back version

# 4. Investigate the issue
vercel logs <bad-deployment-url>
```
